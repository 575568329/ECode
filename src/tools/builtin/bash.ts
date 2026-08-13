/**
 * bash 工具（副作用）：执行 shell 命令。
 *
 * 详设 §2.3 安全约束。M1 最小版（plan 决策）：
 *   ✅ timeout 30s（超时杀进程、转 is_error）
 *   ✅ cwd 约束（在 ctx.cwd 执行）
 *   ✅ 退出码非 0 正常返回（含 stderr + 退出码，交 LLM 判断，recoverable）
 *   ✅ AbortSignal（中断杀进程）
 *   ⬜ 危险命令拦截 / 30KB 头尾中截 → 留 M3
 *
 * 跨平台（详设 §4.6）：Windows 显式 Git Bash（SHELL 缺省回退 bash.exe），
 * 非 Windows 用系统 sh。按 process.platform 探测，不写死。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Tool } from '../interface.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Windows 下解析 Git Bash 路径：SHELL → 常见安装路径 → where bash 探测 PATH → 回退。 */
function resolveGitBash(): string {
  const shell = process.env.SHELL
  if (shell && shell.includes('bash') && existsSync(shell)) return shell
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // where bash 探测 PATH（Git for Windows 常把 bin 加进 PATH）
  try {
    const out = execSync('where bash', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const found = out
      .split('\n')
      .map((s) => s.trim())
      .find((p) => p !== '' && existsSync(p))
    if (found) return found
  } catch {
    // where 不可用或未找到
  }
  return candidates[0]
}

interface ExecResult {
  content: string
  is_error?: boolean
}

/** 跨平台 spawn 一个 shell 命令。 */
function spawnShell(command: string, cwd: string): ChildProcess {
  if (process.platform === 'win32') {
    const bash = resolveGitBash()
    return spawn(bash, ['-c', command], { cwd })
  }
  return spawn(command, { cwd, shell: 'sh' })
}

/** 输出截断阈值（§5.1：30KB；config 可配扩展留 M4） */
const BASH_MAX_OUTPUT_BYTES = 30_720

/** 危险命令正则黑名单（§5.2，D4：命中直接 is_error，不 spawn、不让 LLM 重试）。 */
const DANGEROUS_PATTERNS = [
  /rm\s+-\w*r\w*f?\s+\/(\s|$)/, // rm -rf /
  /rm\s+-\w*r\w*f?\s+--no-preserve-root/, // rm -rf --no-preserve-root
  /\bsudo\b/, // sudo（提权）
  />\s*\/dev\/sd[a-z]/, // 写裸盘
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, // fork bomb :(){:|:&};:
  /\|\s*(sh|bash)\b/, // curl|sh
  /\bmkfs\b/, // 格式化
  /dd\s+.*of=\/dev\/disc/, // dd 写盘
]

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command))
}

/** 输出超阈值时头尾各半中截（§5.1：防刷屏 + 防 LLM 编造截断内容）。 */
export function truncateOutput(s: string): string {
  const bytes = Buffer.byteLength(s, 'utf8')
  if (bytes <= BASH_MAX_OUTPUT_BYTES) return s
  const half = Math.floor(BASH_MAX_OUTPUT_BYTES / 2)
  const buf = Buffer.from(s, 'utf8')
  const head = buf.subarray(0, half).toString('utf8')
  const tail = buf.subarray(bytes - half).toString('utf8')
  const omitted = bytes - BASH_MAX_OUTPUT_BYTES
  return `${head}\n…（中间 ${omitted} 字节已截断，需要完整用 read_file/grep，不要编造）\n${tail}`
}

export const bashTool: Tool = {
  name: 'bash',
  description: '执行 shell 命令（Git Bash / sh）。命令在当前工作目录执行。退出码非 0 时输出含 stderr 和退出码。',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell 命令' },
    },
    required: ['command'],
  },
  readonly: false,
  timeout_ms: DEFAULT_TIMEOUT_MS,

  async execute(args, ctx) {
    const { command } = args as { command: string }
    // 危险命令拦截（D4：正则黑名单，命中直接 is_error，不 spawn）
    if (isDangerous(command)) {
      return { content: `危险命令已拦截：${command}`, is_error: true }
    }
    const timeout = this.timeout_ms ?? DEFAULT_TIMEOUT_MS

    return new Promise<ExecResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawnShell(command, ctx.cwd)
      } catch (e) {
        resolve({ content: `启动失败: ${e instanceof Error ? e.message : String(e)}`, is_error: true })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const done = (res: ExecResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
        resolve(res)
      }

      const timer = setTimeout(() => done({ content: `命令超时 (${timeout}ms)`, is_error: true }), timeout)

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', (e) => done({ content: `执行失败: ${e.message}`, is_error: true }))
      child.on('close', (code) => {
        // 合并 stdout + stderr（若有）；退出码非 0 时附退出码（recoverable，交 LLM 判断）
        const parts: string[] = []
        if (stdout) parts.push(stdout)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        if (code !== 0) parts.push(`[退出码 ${code}]`)
        done({ content: truncateOutput(parts.join('\n') || '(无输出)') })
      })

      // 中断：abort 杀进程
      ctx.signal.addEventListener(
        'abort',
        () => done({ content: '命令被中断', is_error: true }),
        { once: true },
      )
    })
  },
}
