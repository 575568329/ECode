/**
 * 跨平台 shell 进程工具（M7 P6.1 / M6 遗留债 #3 的收敛点）。
 *
 * ECode 首要环境 Windows/Git Bash：hook command 与 bash 工具共用同一 shell 解析
 * （SHELL → 常见安装路径 → where bash → 回退），用户在 hook 里写的命令语法与
 * bash 工具一致，不产生第二套心智。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Windows 下解析 Git Bash 路径：SHELL → 常见安装路径 → where bash 探测 PATH → 回退。 */
export function resolveGitBash(): string {
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

/** 跨平台 spawn 一条 shell 命令（win32=Git Bash -c；其余=sh -c）。 */
export function spawnShellCommand(command: string, cwd: string): ChildProcess {
  if (process.platform === 'win32') {
    const bash = resolveGitBash()
    return spawn(bash, ['-c', command], { cwd })
  }
  return spawn(command, { cwd, shell: 'sh' })
}

/**
 * 危险命令黑名单（§5.2，D4）：命中直接拒绝执行、不让重试。
 * bash 工具与 hook command 执行体共用同一份（H5：第三方 hooks 等于第三方命令执行，必须过拦截）。
 */
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

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command))
}
