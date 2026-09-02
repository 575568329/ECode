/**
 * 跨平台 shell 进程工具（M7 P6.1 / M6 遗留债 #3 的收敛点）。
 *
 * ECode 首要环境 Windows/Git Bash：hook command 与 bash 工具共用同一 shell 解析
 * （SHELL → 候选清单 → where bash → 抛指引错误），用户在 hook 里写的命令语法与
 * bash 工具一致，不产生第二套心智。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizedProcessEnv } from './mcp/adapt.js'

/**
 * resolveGitBash 模块级缓存：命中路径；GIT_BASH_MISS=「未找到」负缓存哨兵——
 * 探过即记（否则无 Git Bash 机器每次调用重付 17 次 existsSync + 一次 execSync 同步探测；
 * 审阅 P2-1：改 throw 时曾丢掉负缓存，每次调用全量重探——终审逮出：负缓存命中分支
 * 重调 probeGitBash 等于没缓存，改为伴随错误实例原样重抛）。
 */
const GIT_BASH_MISS = ''
let gitBashCache: string | undefined
let gitBashMissError: Error | undefined // 负缓存伴随错误：命中时原样重抛，不重探

/** 测试重置缓存（改 env/文件系统后重新探测用；对齐 clock.ts 的 __reset 模式） */
export function __resetGitBashCacheForTest(): void {
  gitBashCache = undefined
  gitBashMissError = undefined
}

/** Windows 下解析 Git Bash 路径（详设 §4.6）。
 *  结果模块级缓存（P1 修复：每次 spawnShellCommand 重复 4 次 existsSync + 可能一次
 *  execSync('where bash')，请求路径同步阻塞——探测一次进程内不变，缓存零失效场景）。
 *
 *  2026-08-30 真机实证扩展：用户 Git 装在自定义盘（D:\tool\Git）且未进 PATH——四步探测全空后
 *  旧实现回退硬编码 `C:\Program Files\Git\bin\bash.exe` 并带着假路径 spawn，报 ENOENT 让人
 *  误以为是 Git 没装。现在：①候选清单补自定义盘与按用户安装常见位置（D:\tool\Git 本机实证
 *  命中；LOCALAPPDATA 官方双默认之一）；②全空不再静默回退，抛带修复指引的明确错误
 *  （ENOENT 不可诊断，此错可）；③负缓存保留（探过未找到即记，不重复全量探测）。 */
/** 候选清单单一事实源（导出供测试同源遍历——审阅 P2-2：测试手工复制清单会漂移）。
 *  动态项：LOCALAPPDATA 下的按用户安装（Git for Windows 默认双落点之一，缺它漏半壁）。 */
export function gitBashCandidates(): string[] {
  const local = process.env.LOCALAPPDATA
  return [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    // 自定义盘常见位置（2026-08-30 真机：D:\tool\Git 命中）。中文 Windows 自定义安装
    // 高频落点，逐一 existsSync 成本可忽略（进程级缓存，一次探测）
    'D:\\tool\\Git\\bin\\bash.exe',
    'D:\\tool\\Git\\usr\\bin\\bash.exe',
    'D:\\Program Files\\Git\\bin\\bash.exe',
    'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'D:\\Git\\bin\\bash.exe',
    'D:\\Git\\usr\\bin\\bash.exe',
    'E:\\tool\\Git\\bin\\bash.exe',
    'E:\\tool\\Git\\usr\\bin\\bash.exe',
    'E:\\Program Files\\Git\\bin\\bash.exe',
    'E:\\Git\\bin\\bash.exe',
    'C:\\Users\\Public\\Git\\bin\\bash.exe',
    // 按用户安装默认位置（审阅 P3-2：%LOCALAPPDATA%\Programs\Git 是官方双默认之一）
    ...(local !== undefined
      ? [join(local, 'Programs', 'Git', 'bin', 'bash.exe'), join(local, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')]
      : []),
  ]
}

/** 探测主体：SHELL → 候选清单 → where bash（返回路径或 throw 指引错误）。 */
function probeGitBash(): string {
  const shell = process.env.SHELL
  if (shell && shell.includes('bash') && existsSync(shell)) return shell
  for (const p of gitBashCandidates()) {
    if (existsSync(p)) return p
  }
  // where bash 探测 PATH（Git for Windows 常把 bin 加进 PATH）。
  // WSL 的 System32\bash.exe 是 Linux 侧启动器（不能跑 Windows cwd 的命令），排除——
  // 审阅 P3-1：不排除时 WSL 机器会「探测成功」实际 spawn 后行为错乱
  try {
    const out = execSync('where bash', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, // daemon（无控制台）首次探测闪 cmd.exe 窗——与 spawn 系同压
    })
    const found = out
      .split('\n')
      .map((s) => s.trim())
      .find((p) => p !== '' && !/system32/i.test(p) && existsSync(p))
    if (found !== undefined) return found
  } catch {
    // where 不可用或未找到
  }
  // 全空：显式报错而非回退假路径（旧回退 `C:\Program Files\...` spawn 必 ENOENT——
  // 错误面目全非不可诊断；此处给人话 + 两条修复路径）
  throw new Error(
    '未找到 Git Bash（bash.exe）。修复任选其一：\n' +
      '  1) 设环境变量 SHELL 指向 bash.exe 完整路径（如 D:\\tool\\Git\\bin\\bash.exe）后重启 ECode；\n' +
      '  2) 安装 Git for Windows 到默认路径（https://git-scm.com/download/win）。\n' +
      '  bash 工具与 hooks 依赖它；文件/对话功能不受影响。',
  )
}

export function resolveGitBash(): string {
  if (gitBashCache !== undefined) {
    // 负缓存命中：伴随错误原样重抛（终审 P2-1 修复——曾误写成 return probeGitBash()
    // 等于每次全量重探，负缓存形同虚设）。理论不可达分支：负缓存必有伴随错误
    if (gitBashCache === GIT_BASH_MISS) {
      throw gitBashMissError ?? new Error('未找到 Git Bash（bash.exe）')
    }
    return gitBashCache
  }
  try {
    const found = probeGitBash()
    gitBashCache = found
    return found
  } catch (e) {
    gitBashCache = GIT_BASH_MISS // 负缓存（审阅 P2-1：无 Git Bash 机器不重复全量探测）
    gitBashMissError = e instanceof Error ? e : new Error(String(e))
    throw e
  }
}

/** 跨平台 spawn 一条 shell 命令（win32=Git Bash -c；其余=sh -c）。
 *  Unix 侧 detached=true 起独立进程组（pid==pgid），killTree 才能 kill(-pid) 杀组；
 *  windowsHide 防闪控制台窗。
 *  F-18 纵深（dogfood 批2a §10.1b）：统一接 sanitizedProcessEnv() 净化 env——bash/hooks/
 *  quality/后台任务子进程不再整份继承宿主 env，密钥形态变量（KEY/TOKEN/SECRET...）一处收口剔除
 *  （与 MCP stdio 同款；此前 hooks 裸继承是自相矛盾）。 */
export function spawnShellCommand(command: string, cwd: string): ChildProcess {
  if (process.platform === 'win32') {
    const bash = resolveGitBash()
    return spawn(bash, ['-c', command], { cwd, windowsHide: true, env: sanitizedProcessEnv() })
  }
  return spawn(command, { cwd, shell: 'sh', detached: true, env: sanitizedProcessEnv() })
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
  /\b(sudo|doas|su)\b/, // 提权类：sudo/doas/su（\bsu\b 有把正文里的 "su" 误判的代价，换取 su root/doas 覆盖——黑名单取向选覆盖面）
  />\s*\/dev\/sd[a-z]/, // 写裸盘
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, // fork bomb :(){:|:&};:
  // 管道进任意 shell（curl|sh 家族）：可带绝对路径前缀（| /bin/sh）与包裹引号
  // （| "/bin/sh"，与 sandbox 分词口径对齐）、覆盖常见 shell 名（旧正则只认 sh|bash，
  // | zsh、| /bin/dash 全漏）
  /\|\s*["']?(\/\S*\/)?(sh|bash|zsh|dash|ksh|fish|csh|tcsh)\b/,
  /\bmkfs\b/, // 格式化
  /dd\s+.*of=\/dev\/disc/, // dd 写盘
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command))
}
