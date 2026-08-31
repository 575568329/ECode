/**
 * T3：入口 daemon 发现/拉起/附着（方案 §4.1 入口序）。
 *
 * 发现=注册文件（~/.ecode/server.json：id/port/token/pid/version/name）+ pid 探活 + /health
 * 比对 + 版本匹配——四验全过才附着。拉起=detached spawn（stdio:'ignore'+windowsHide——
 * win32 detached=CREATE_NEW_CONSOLE 弹窗、stdio 继承在 TUI 退出后 EPIPE 杀 daemon——架构席
 * P0-1 实证锚点 index.ts restartProcess）+拉起锁串行化（冷启动竞态双 spawn——架构席 P0-2）
 * +env 白名单（auto-spawn 不回退项目 .env 的 serve 三元组——安全席 P0-2 注入面）。
 * 版本不符/health 不达：拒绝附着+提示，绝不 spawn（保住跑着的任务——D-T1a）。
 */

import { readFileSync, rmSync, statSync, openSync, closeSync, unlinkSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { MultiTransport } from '../protocol/multiTransport.js'

const REG_PATH = join(homedir(), '.ecode', 'server.json')
const SPAWN_LOCK_PATH = join(homedir(), '.ecode', 'daemon-spawn.lock')
const READY_TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 2_000

export interface ServerReg {
  id: string
  port: number
  token: string
  pid: number
  /** T3：附着前版本比对（旧 daemon 注册文件无此字段=视为版本不符——拒绝附着） */
  version?: string
  /** T3：主机别名（多台电脑区分——顶栏显示） */
  name?: string
}

export function myVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}

export function daemonName(): string {
  return process.env.ECODE_SERVE_NAME ?? hostname()
}

export function readServerReg(): ServerReg | null {
  try {
    const reg = JSON.parse(readFileSync(REG_PATH, 'utf8')) as ServerReg
    if (typeof reg.port !== 'number' || typeof reg.token !== 'string' || typeof reg.pid !== 'number') return null
    return reg
  } catch {
    return null
  }
}

/** 原子写注册文件（tmp+rename——与拉起锁竞态下防撕裂 JSON；架构席 P2-3） */
export function writeServerRegAtomic(reg: ServerReg): void {
  const tmp = `${REG_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* 非 POSIX（win32）chmod 无强制力——文档披露不阻断 */
  }
  renameSync(tmp, REG_PATH)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface HealthInfo {
  ok: boolean
  id?: string
  version?: string
  name?: string
}

async function probeHealth(port: number): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (!res.ok) return null
    return (await res.json()) as HealthInfo
  } catch {
    return null
  }
}

export interface AttachOutcome {
  attached: true
  transport: MultiTransport
  daemonName: string
}
export interface EmbeddedOutcome {
  attached: false
  /** 用户可读的降级/拒绝原因（顶栏提示；--local=空） */
  reason: string
  /** 版本不符——不自动降级 Embedded，提示用户显式选择（--local 或 serve stop） */
  versionMismatch?: boolean
}
export type DaemonOutcome = AttachOutcome | EmbeddedOutcome

/** pid 探活+health+id 比对+版本匹配四验（§4.5.3 身份双验在此收敛） */
async function verifyAndAttach(reg: ServerReg, logger: DaemonLogger): Promise<AttachOutcome | null> {
  if (!pidAlive(reg.pid)) return null
  const health = await probeHealth(reg.port)
  if (health === null || health.ok !== true) return null
  if (health.id !== undefined && health.id !== reg.id) return null // 陈旧/预置注册文件误附（安全席 P1-2）
  // P1-7：版本比对统一以 health.version（daemon 实际运行版本）为准；任一侧缺失=视为不符
  //（旧注册文件/旧 daemon 无 version → 拒绝附着走提示路径——§4.4，不许静默放过）
  const daemonVer = health.version
  if (daemonVer === undefined || daemonVer !== myVersion()) {
    logger.warn('daemon', 'version_mismatch', { daemon: daemonVer, cli: myVersion() })
    return null
  }
  const transport = new MultiTransport({
    baseUrl: `http://127.0.0.1:${reg.port}`,
    token: reg.token,
    project: process.cwd(),
    getSessionId: () => undefined,
    canAnswer: true,
  })
  return { attached: true, transport, daemonName: reg.name ?? health.name ?? hostname() }
}

type DaemonLogger = {
  info: (category: 'daemon', event: string, payload?: unknown) => void
  warn: (category: 'daemon', event: string, payload?: unknown) => void
}

/** spawn env 白名单：shell export 的杂项 env（含潜在密钥）不长驻 daemon；serve 绑定三元组
 *  只认外部环境变量（不回退项目 .env——恶意仓库 .env 静默制造局域网常驻暴露的注入面封死）。 */
function spawnEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'NODE_OPTIONS', 'SHELL', 'TERM', 'LANG', 'TZ']
  const env: Record<string, string> = {}
  for (const k of allow) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ECODE_')) env[k] = process.env[k] as string
  }
  const key = process.env.ANTHROPIC_API_KEY
  if (key !== undefined) env.ANTHROPIC_API_KEY = key
  // T3 安全（§4.5.2）：auto-spawn 标记——serveMode 据此对 serve 绑定三元组跳过项目 .env 回退
  //（恶意仓库 .env 写 HOST=0.0.0.0+密码→日常 ecode 静默制造局域网常驻暴露的注入面封死）
  env.ECODE_AUTO_SPAWN = '1'
  return env as NodeJS.ProcessEnv
}

function spawnDetachedServe(logger: DaemonLogger): ChildProcess | null {
  // 从当前进程形态重建 serve 命令（execArgv 显式拼进 argv——tsx loader 不自动继承，restartProcess 同款）。
  // 'serve' 必须插在脚本路径之后、用户参数之前——parseArgv 只认 argv[0]（尾部追加会把
  // `ecode --history X` 的子进程解析成「单次模式 prompt=serve」烧 token——P1-1 实证）
  const scriptIdx = Math.max(0, process.argv.length - process.argv.slice(2).length - (process.execArgv.length > 0 ? 1 : 0))
  const userArgs = process.argv.slice(2)
  const argv = [...process.execArgv, process.argv[scriptIdx] ?? process.argv[1], 'serve', ...userArgs]
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore', // TUI 退出后 pipe 断裂会让继承 stdio 的 daemon EPIPE 崩溃（架构席 P0-1）
    windowsHide: true, // win32 detached=CREATE_NEW_CONSOLE 弹窗压制
    env: spawnEnv(),
    cwd: process.cwd(),
  })
  child.unref()
  child.on('error', (e) => logger.warn('daemon', 'spawn_failed', { message: e.message }))
  return child
}

/** 入口序（§4.1）：发现→四验→附着；无 daemon→拉起锁→detached spawn→轮询附着；失败降级 Embedded */
export async function ensureDaemonAttach(opts: {
  logger: DaemonLogger
  forceEmbedded: boolean
}): Promise<DaemonOutcome> {
  if (opts.forceEmbedded) return { attached: false, reason: '本地模式（--local）' }
  const myVer = myVersion()

  // 1) 发现既有 daemon（四验）
  const existing = readServerReg()
  if (existing !== null) {
    const attached = await verifyAndAttach(existing, opts.logger)
    if (attached !== null) return attached
    // 区分「健康但版本不符」（拒绝附着+提示，绝不 spawn/删注册——D-T1a）与「陈旧注册」（清理重拉）
    if (pidAlive(existing.pid)) {
      const health = await probeHealth(existing.port)
      if (health !== null && health.ok === true && (health.id === undefined || health.id === existing.id)) {
        // P1-5：健康的活 daemon——无论版本是否匹配都**不删注册**（删了它存活期内永久降级）
        const daemonVer = health.version ?? existing.version
        if (daemonVer === undefined || daemonVer !== myVer) {
          return {
            attached: false,
            versionMismatch: true,
            reason: `daemon 版本（${daemonVer ?? '未知'}）与当前 CLI（${myVer}）不一致——任务保留在后台运行。可运行 ecode serve stop 升级后台，或 ecode --local 本地模式`,
          }
        }
      }
      return { attached: false, reason: 'daemon 健康检查未通过（可能正在启动）——可 ecode --local 或稍后重试' }
    }
    try {
      rmSync(REG_PATH, { force: true })
    } catch {
      /* 幂等 */
    }
  }

  // 2) 拉起锁（冷启动竞态：双 ecode 同时首启只 spawn 一个 daemon——架构席 P0-2）
  let haveLock = false
  try {
    const fd = openSync(SPAWN_LOCK_PATH, 'wx')
    closeSync(fd)
    haveLock = true
  } catch {
    // 已有进程在拉起——锁龄超过 READY_TIMEOUT 视为持锁进程死亡（kill -9/断电），抢删重试一次
    try {
      const age = Date.now() - statSync(SPAWN_LOCK_PATH).mtimeMs
      if (age > READY_TIMEOUT_MS) {
        unlinkSync(SPAWN_LOCK_PATH)
        const fd = openSync(SPAWN_LOCK_PATH, 'wx')
        closeSync(fd)
        haveLock = true
      }
    } catch {
      /* 抢锁仍失败/已消失——按无锁等待 */
    }
  }
  try {
    if (haveLock) {
      opts.logger.info('daemon', 'spawn', { name: hostname() })
      spawnDetachedServe(opts.logger)
    }
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const reg = readServerReg()
      if (reg === null) continue
      const attached = await verifyAndAttach(reg, opts.logger)
      if (attached !== null) return attached
    }
    return { attached: false, reason: haveLock ? 'daemon 拉起失败（查看 daemon 日志）' : '等待其他进程拉起 daemon 超时' }
  } finally {
    if (haveLock) {
      try {
        unlinkSync(SPAWN_LOCK_PATH)
      } catch {
        /* 幂等 */
      }
    }
  }
}

export { REG_PATH }
