/**
 * M12-B8：项目注册表——多项目 daemon 的核心（path → ProjectHost 冷启动/回收/互斥）。
 *
 * - 冷启动语义（harness 同款）：list/浏览零实例；acquire（首个 prompt）才 makeDeps(cwd)+HostSession
 * - acquire 三段式：live 复用 → 冷启动单飞去重（并发只装配一次）→ 所有权栅栏（互斥占用拒绝）
 * - 路径校验三件套（v1.2 P1-5）：存在性 + realpath 规范化（防同目录多形态绕互斥）+ 历史反推项目
 *   首次拉起需 confirm=true 二次确认（显式注册的豁免——恶意仓库 hooks 防线）
 * - 空闲回收：N 分钟无请求 dispose（confirm 悬置不回收——宁等勿杀，Q12）
 * - 项目互斥标记：`~/.ecode/sessions/` 同目录 lock 文件（open 'wx' 原子占坑 + 0600——TOCTOU/预置 symlink 双防）
 */

import { openSync, closeSync, writeSync, readFileSync, existsSync, realpathSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HostSession } from '../host/session.js'

export interface ProjectEntry {
  path: string
  registered: boolean
}

export interface AcquireResult {
  ok: boolean
  reason?: 'not-exist' | 'locked' | 'need-confirm'
  lockHolder?: string
  host?: HostSession
}

export interface ProjectHostOptions {
  /** 冷启动工厂（cli 传入：makeDeps(cwd)+sessionId+HostSession 装配） */
  createSession: (cwd: string) => HostSession
  /** 空闲回收阈值（分钟；0=不回收——测试用） */
  idleMinutes?: number
  lockDir?: string
}

export class ProjectRegistry {
  private readonly hosts = new Map<string, HostSession>()
  private readonly pendingAcquire = new Map<string, Promise<HostSession | null>>()
  private readonly registered = new Set<string>()
  private readonly lastActive = new Map<string, number>()
  private readonly idleMinutes: number
  private readonly lockDir: string

  constructor(private readonly opts: ProjectHostOptions) {
    this.idleMinutes = opts.idleMinutes ?? 30
    this.lockDir = opts.lockDir ?? join(homedir(), '.ecode', 'sessions')
  }

  /** 项目发现：显式注册（--add）+ 历史会话 meta.cwd 反推（由调用方喂入——注册表不读 history） */
  register(path: string): void {
    this.registered.add(this.normalize(path))
  }

  listKnown(): ProjectEntry[] {
    return [...this.registered].map((p) => ({ path: p, registered: true }))
  }

  listActive(): ProjectEntry[] {
    return [...this.hosts.keys()].map((p) => ({ path: p, registered: this.registered.has(p) }))
  }

  private normalize(path: string): string {
    // 统一正斜杠（HTTP 项目路径约定；Windows realpath 返回反斜杠——两端一致才可 Set 命中）
    const fwd = (p: string): string => p.split(String.fromCharCode(92)).join('/')
    try {
      return fwd(realpathSync(path))
    } catch {
      return fwd(path)
    }
  }

  private lockPath(cwd: string): string {
    // 项目路径哈希文件名（sha1 40 hex——base64 截断 40 字符在长公共前缀（同 Temp 目录）下会碰撞，实测）
    const key = createHash('sha1').update(cwd).digest('hex')
    return join(this.lockDir, `project-${key}.lock`)
  }

  /** 项目级互斥占坑（open 'wx' 原子；锁文件写 {pid,time}——stale 检测见 takeStale） */
  private tryLock(cwd: string): { ok: boolean; holder?: string } {
    mkdirSync(this.lockDir, { recursive: true })
    const lp = this.lockPath(cwd)
    try {
      const fd = openSync(lp, 'wx', 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }))
      closeSync(fd)
      return { ok: true }
    } catch {
      // stale 恢复（审阅 P1-5）：持有进程已死则接管——否则崩溃一次该项目永久 locked
      if (this.takeStale(lp)) return this.tryLock(cwd)
      try {
        const raw = readFileSync(lp, 'utf8')
        const pid = (JSON.parse(raw) as { pid?: number }).pid
        return { ok: false, holder: pid !== undefined ? `pid ${pid}` : '未知持有者' }
      } catch {
        return { ok: false }
      }
    }
  }

  /** 持有进程已死 → 删锁返回 true（进程存活探测：Windows/POSIX 通用 process.kill(pid,0)） */
  private takeStale(lp: string): boolean {
    try {
      const pid = (JSON.parse(readFileSync(lp, 'utf8')) as { pid?: number }).pid
      if (pid === undefined || pid === process.pid) return false
      process.kill(pid, 0) // 存活则抛 ESRCH 之外不抛——已死抛错
      return false // 持有者活着
    } catch (e) {
      // EPERM=进程存在但无权限（仍算活着）；ESRCH=已死 → 接管
      if ((e as { code?: string }).code === 'EPERM') return false
      try {
        unlinkSync(lp)
        return true
      } catch {
        return false
      }
    }
  }

  private unlock(cwd: string): void {
    try {
      unlinkSync(this.lockPath(cwd))
    } catch {
      // 锁文件已失（外部清理）——幂等
    }
  }

  /** acquire：live 复用 → 冷启动（单飞去重）→ 栅栏 */
  async acquire(rawPath: string, opts: { confirm?: boolean } = {}): Promise<AcquireResult> {
    if (!existsSync(rawPath)) return { ok: false, reason: 'not-exist' }
    const cwd = this.normalize(rawPath)
    if (!statSync(cwd).isDirectory()) return { ok: false, reason: 'not-exist' }

    // 历史反推项目（未显式注册）首次拉起需 confirm（防恶意仓库 hooks 静默执行）
    if (!this.registered.has(cwd) && this.hosts.get(cwd) === undefined && opts.confirm !== true) {
      return { ok: false, reason: 'need-confirm' }
    }

    const live = this.hosts.get(cwd)
    if (live !== undefined) {
      this.lastActive.set(cwd, Date.now())
      return { ok: true, host: live }
    }

    // 冷启动单飞去重（并发 acquire 只装配一次）
    const inflight = this.pendingAcquire.get(cwd)
    if (inflight !== undefined) {
      const h = await inflight
      return h !== null ? { ok: true, host: h } : { ok: false, reason: 'locked' }
    }

    // deferred：先登记再去装配——promise 体同步失败时 delete 会先于 set 执行留下死条目（实测竞态）
    let settle!: (h: HostSession | null) => void
    const p = new Promise<HostSession | null>((res) => {
      settle = res
    })
    this.pendingAcquire.set(cwd, p)
    void (async () => {
      const lock = this.tryLock(cwd)
      if (!lock.ok) {
        this.pendingAcquire.delete(cwd)
        settle(null)
        return
      }
      const host = this.opts.createSession(cwd)
      this.hosts.set(cwd, host)
      this.lastActive.set(cwd, Date.now())
      this.pendingAcquire.delete(cwd)
      settle(host)
    })()
    const h = await p
    return h !== null ? { ok: true, host: h } : { ok: false, reason: 'locked', lockHolder: '' }
  }

  /** 活跃度打点（prompt/事件订阅等 touch 点调用） */
  touch(cwd: string): void {
    this.lastActive.set(this.normalize(cwd), Date.now())
  }

  /** 审批悬置不回收（Q12）：host 有 pending 审批时跳过本轮回收 */
  async sweepIdle(): Promise<number> {
    // idleMinutes=0 → 立即过期（测试语义）
    const cutoff = Date.now() - this.idleMinutes * 60_000
    let reclaimed = 0
    for (const [cwd, host] of [...this.hosts]) {
      const active = this.lastActive.get(cwd) ?? Date.now()
      if (active > cutoff) continue
      // confirm 悬置不回收（Q12）：有订阅者或 broker 有 pending 均视为活跃（审阅 P1-8：曾只查订阅者）
      const h = host as unknown as { channel: { subscriberCount: number }; brokerPending: number }
      if (h.channel.subscriberCount > 0 || h.brokerPending > 0) continue
      host.dispose()
      this.hosts.delete(cwd)
      this.lastActive.delete(cwd)
      this.unlock(cwd)
      reclaimed++
    }
    return reclaimed
  }

  disposeAll(): void {
    for (const [cwd, host] of this.hosts) {
      host.dispose()
      this.unlock(cwd)
    }
    this.hosts.clear()
  }
}
