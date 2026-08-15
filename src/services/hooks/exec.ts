/**
 * hook command 执行器（H-P2，H3 协议）。
 *
 * 执行模型：spawn（win32=Git Bash，与 bash 工具同一 shell——用户写 hook 命令无第二套语法）
 * → stdin 喂事件 JSON → 收 stdout/stderr → 按退出码定协议：
 *   - exit 0：stdout 是 JSON 则按 HookOutput 解析；非 JSON/空 = 纯通知（null）
 *   - exit 2：轻量 block（无 JSON 协议的阻塞，reason 取 stderr 末行）
 *   - 其他：执行失败 → throw（runner fail-open：warn + 放行，H5）
 * 超时默认 60s（hook 级与 handler 级 timeout_ms 取小者）；abort 信号杀进程。
 * 危险命令黑名单与 bash 工具共用（H5：第三方 hooks = 第三方命令执行）。
 */

import { isDangerousCommand, spawnShellCommand } from '../proc.js'
import type { HookExecutor, HookOutput } from './types.js'

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000
/** stderr 进错误信息的摘要上限（防巨量输出撑爆日志）。 */
const STDERR_EXCERPT_LIMIT = 2_000

export const runCommandHook: HookExecutor = async (spec, input, opts) => {
  if (spec.handler.kind !== 'command') {
    throw new Error(`hook 形态未实现：${spec.handler.kind}（MVP 仅 command）`)
  }
  const command =
    process.platform === 'win32' && spec.handler.command_windows !== undefined
      ? spec.handler.command_windows
      : spec.handler.command
  if (isDangerousCommand(command)) {
    throw new Error(`hook 命令命中危险黑名单，拒绝执行：${command}`)
  }
  const timeoutMs = Math.min(
    spec.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS,
    spec.handler.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS,
  )

  return await new Promise<HookOutput | null>((resolve, reject) => {
    const child = spawnShellCommand(command, process.cwd())
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`hook 超时（${timeoutMs}ms）：${command}`)))
    }, timeoutMs)

    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`hook 被中断：${command}`)))
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onAbort)
      settle()
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      finish(() => reject(new Error(`hook 启动失败：${command}：${e.message}`)))
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(parseOutput(stdout)))
        return
      }
      if (code === 2) {
        const reason = stderr.trim().split('\n').pop() ?? ''
        finish(() => resolve({ continue: false, ...(reason !== '' ? { reason } : {}) }))
        return
      }
      const excerpt = stderr.slice(-STDERR_EXCERPT_LIMIT).trim()
      finish(() =>
        reject(
          new Error(
            `hook 退出码 ${code}：${command}${excerpt !== '' ? `（stderr：${excerpt}）` : ''}`,
          ),
        ),
      )
    })

    // stdin：事件 JSON 喂入后关闭（hook 不必读，忽略 EPIPE）
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(input), 'utf8')
  })
}

/** stdout → HookOutput：空/非 JSON = 纯通知（null）；字段级过滤（未知字段剥离）。 */
function parseOutput(stdout: string): HookOutput | null {
  const text = stdout.trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = parsed as Record<string, unknown>
  const out: HookOutput = {}
  if (raw.continue === false) out.continue = false
  if (raw.updatedInput !== undefined) out.updatedInput = raw.updatedInput
  if (typeof raw.additionalContext === 'string' && raw.additionalContext !== '') out.additionalContext = raw.additionalContext
  if (typeof raw.systemMessage === 'string' && raw.systemMessage !== '') out.systemMessage = raw.systemMessage
  if (typeof raw.reason === 'string' && raw.reason !== '') out.reason = raw.reason
  return Object.keys(out).length > 0 ? out : null
}
