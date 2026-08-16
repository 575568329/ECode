/**
 * QualityGate：编辑后 lint/test 自动回喂（M9-P3，aider 质量闭环裁剪）。
 *
 * 触发：一轮工具中有 ≥1 个编辑类工具成功（write_file/edit_file）→ 轮末聚合跑一次
 * （同轮多编辑不重复；由 loop 的 afterTools 回调驱动，loop 只透传结果清单不认识 lint）。
 * 回喂：失败输出作为 user 文本消息追加（`[lint]`/`[test]` 前缀）——协议上 tool_result
 * 必须配对 tool_use（无主 result 会 400），信息性回喂走 user 文本，模型下一轮看到自纠。
 * 熔断：连续 2 次失败且输出无变化（模型修复无效）→ 停止自动跑 + warn 提示接手（防死循环烧钱）。
 * 全绿静默（不打扰）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnShellCommand } from './proc.js'

/** 触发回喂的编辑类工具 */
const EDIT_TOOLS = new Set(['write_file', 'edit_file'])
/** 连续失败（输出无变化）熔断阈值 */
const CIRCUIT_BREAK_LIMIT = 2

export interface QualityCommands {
  lint?: string
  test?: string
}

export interface QualityRunOutcome {
  command: string
  exitCode: number
  output: string
}

export interface QualityGateOpts {
  commands: QualityCommands
  /** 命令执行器（注入便于测试）；抛错/超时由调用方在 runner 内处理为 exitCode 非 0 */
  run: (command: string) => Promise<QualityRunOutcome>
  warn?: (msg: string) => void
}

/**
 * 探测 lint/test 命令：config 显式覆盖 > package.json scripts 的 lint/test > 关闭（undefined）。
 */
export function detectQualityCommands(
  cwd: string,
  override?: { lintCommand?: string; testCommand?: string },
): QualityCommands {
  const commands: QualityCommands = {}
  if (override?.lintCommand !== undefined && override.lintCommand !== '') commands.lint = override.lintCommand
  if (override?.testCommand !== undefined && override.testCommand !== '') commands.test = override.testCommand
  if (commands.lint !== undefined && commands.test !== undefined) return commands
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    if (commands.lint === undefined && typeof scripts.lint === 'string' && scripts.lint !== '') commands.lint = `npm run lint`
    if (commands.test === undefined && typeof scripts.test === 'string' && scripts.test !== '') commands.test = `npm run test`
  } catch {
    // 无 package.json / 解析失败：未探测到的即关闭
  }
  return commands
}

/** 回喂输出的最大长度（字符级截断，防长输出刷屏上下文） */
const FEEDBACK_MAX_CHARS = 4_000

export class QualityGate {
  private readonly commands: QualityCommands
  private readonly run: (command: string) => Promise<QualityRunOutcome>
  private readonly warn: (msg: string) => void
  /** 连续失败（输出无变化）计数；≥2 熔断 */
  private consecutiveFailures = 0
  private lastFailureHash = ''
  private _tripped = false

  constructor(opts: QualityGateOpts) {
    this.commands = opts.commands
    this.run = opts.run
    this.warn = opts.warn ?? (() => {})
  }

  /** 熔断态（停止自动跑；会话级——重启/新会话复位） */
  get tripped(): boolean {
    return this._tripped
  }

  /** 配置全空（关闭态） */
  get disabled(): boolean {
    return this.commands.lint === undefined && this.commands.test === undefined
  }

  /**
   * 轮末聚合：本轮工具清单里有编辑成功才跑。返回回喂文本（undefined=全绿/不跑/已熔断且非本轮触发的失败）。
   * 熔断语义：第 2 次输出无变化的失败仍回喂（附熔断提示），此后 afterRound 短路。
   */
  async afterRound(tools: Array<{ name: string; isError: boolean }>): Promise<string | undefined> {
    if (this._tripped || this.disabled) return undefined
    const edited = tools.some((t) => EDIT_TOOLS.has(t.name) && !t.isError)
    if (!edited) return undefined

    const failures: string[] = []
    for (const [kind, command] of [
      ['lint', this.commands.lint],
      ['test', this.commands.test],
    ] as Array<['lint' | 'test', string | undefined]>) {
      if (command === undefined) continue
      try {
        const outcome = await this.run(command)
        if (outcome.exitCode !== 0) {
          failures.push(`[${kind}] ${command} 失败（exit ${outcome.exitCode}）：\n${truncateFeedback(outcome.output)}`)
        }
      } catch (e) {
        failures.push(`[${kind}] ${command} 启动失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (failures.length === 0) {
      this.consecutiveFailures = 0 // 全绿重置
      this.lastFailureHash = ''
      return undefined
    }

    const failureText = failures.join('\n\n')
    const hash = createHash('sha256').update(failureText).digest('hex')
    if (hash === this.lastFailureHash) this.consecutiveFailures += 1
    else {
      this.consecutiveFailures = 1
      this.lastFailureHash = hash
    }

    if (this.consecutiveFailures >= CIRCUIT_BREAK_LIMIT) {
      this._tripped = true
      this.warn('lint/test 连续 2 次失败且输出无变化（模型修复无效），已停止自动运行——请人工接手')
      return `${failureText}\n\n[quality] 已连续 ${this.consecutiveFailures} 次修复无效，此后不再自动运行 lint/test；请仔细分析上述输出后修复。`
    }
    return `${failureText}\n\n[quality] 请修复上述问题。`
  }
}

/** 回喂截断（字符级头尾保留） */
function truncateFeedback(s: string): string {
  if (s.length <= FEEDBACK_MAX_CHARS) return s === '' ? '(无输出)' : s
  const half = Math.floor(FEEDBACK_MAX_CHARS / 2)
  return `${s.slice(0, half)}\n…（中间已截断）\n${s.slice(-half)}`
}

/** 默认 runner：shell 执行 + 60s 超时杀进程（cli/TuiApp 装配用；测试注入 mock runner） */
export function makeShellRunner(cwd: string, timeoutMs = 60_000): (command: string) => Promise<QualityRunOutcome> {
  return (command) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawnShellCommand(command, cwd)
      } catch (e) {
        resolve({ command, exitCode: 1, output: `启动失败: ${e instanceof Error ? e.message : String(e)}` })
        return
      }
      let out = ''
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      const timer = setTimeout(() => {
        child.kill()
        resolve({ command, exitCode: 124, output: `${out}
[quality] 超时（${Math.round(timeoutMs / 1000)}s）被终止` })
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ command, exitCode: code ?? 0, output: out })
      })
    })
}
