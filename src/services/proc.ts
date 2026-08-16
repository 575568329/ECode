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

/** 跨平台 spawn 一条 shell 命令（win32=Git Bash -c；其余=sh -c）。
 *  Unix 侧 detached=true 起独立进程组（pid==pgid），killTree 才能 kill(-pid) 杀组；
 *  windowsHide 防闪控制台窗。 */
export function spawnShellCommand(command: string, cwd: string): ChildProcess {
  if (process.platform === 'win32') {
    const bash = resolveGitBash()
    return spawn(bash, ['-c', command], { cwd, windowsHide: true })
  }
  return spawn(command, { cwd, shell: 'sh', detached: true })
}

/** SIGTERM→gracefulMs→SIGKILL 的宽限期（给编译器/测试进程收尾机会；CC 无梯度直接 SIGKILL 是反面教材） */
const TREE_KILL_GRACE_MS = 200

/**
 * 杀整棵进程树（M10 v1.3 修复：单点 child.kill 只杀直接子进程，npm test / dev server
 * 这类起孙进程的命令超时/中断后孙进程泄漏成孤儿——四家 CLI 全部实现树杀）。
 *
 * Windows：taskkill /PID /T /F（控制台进程无优雅信号可言，opencode 同款）；
 * Unix：进程组 SIGTERM → 宽限 → SIGKILL（spawnShellCommand detached 保证 pid==pgid）；
 * 组信号失败（如未 detached）回退单点 kill。进程已退出则幂等直接返回。
 */
export async function killTree(child: ChildProcess, gracefulMs: number = TREE_KILL_GRACE_MS): Promise<void> {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const taskkillTree = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.on('close', () => resolve())
        killer.on('error', () => resolve())
      })
    await taskkillTree()
    // 复查补杀：taskkill /T 树枚举在进程刚出生的窗口偶发漏最深子进程（exit 0 但没杀干净）；
    // 100ms 后主进程仍活则再补一轮。taskkill 本身不可用则退回单点 kill
    await new Promise((res) => setTimeout(res, 100))
    if (child.exitCode === null && child.signalCode === null) {
      await taskkillTree()
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
      }
    }
    return
  }
  const killGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig)
      return true
    } catch {
      return false
    }
  }
  if (!killGroup('SIGTERM')) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
  await new Promise((res) => setTimeout(res, gracefulMs))
  if (child.exitCode === null && child.signalCode === null) {
    if (!killGroup('SIGKILL')) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
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
