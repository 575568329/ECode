/**
 * M12-B8：项目注册表——多项目 daemon 的核心（path → ProjectHost 冷启动/回收/互斥）。
 *
 * - 冷启动语义（harness 同款）：list/浏览零实例；acquire（首个 prompt）才 makeDeps(cwd)+HostSession
 * - acquire 三段式：live 复用 → 冷启动单飞去重（并发只装配一次）→ 所有权栅栏（互斥占用拒绝）
 * - 路径校验三件套（v1.2 P1-5）：存在性 + realpath 规范化（防同目录多形态绕互斥）+ 历史反推项目
 *   首次拉起需 confirm=true 二次确认（显式注册的豁免——恶意仓库 hooks 防线）
 * - M13-W2：值改存 ProjectHost（每项目一个容器，内含会话 Map）；项目级空闲回收退役
 *   （Q5 基座常驻，两家实证）→ registry.sweepSessions 会话级回收（三闸见 ProjectHost）
 * - 项目互斥标记：`~/.ecode/sessions/` 同目录 lock 文件（open 'wx' 原子占坑 + 0600——TOCTOU/预置 symlink 双防）
 */

import { openSync, closeSync, writeSync, readFileSync, existsSync, realpathSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProjectHost } from '../host/project.js'

export interface ProjectEntry {
  path: string
  registered: boolean
}

export interface AcquireResult {
  ok: boolean
  reason?: 'not-exist' | 'locked' | 'need-confirm'
  lockHolder?: string
  host?: ProjectHost
}

export interface ProjectHostOptions {
  /** 项目宿主工厂（cli 传入：makeDeps(cwd)+ProjectHost 装配——M13-W2 起每项目一个容器） */
  createSession: (cwd: string) => ProjectHost
  lockDir?: string
}

export class ProjectRegistry {
  private readonly hosts = new Map<string, ProjectHost>()
  private readonly pendingAcquire = new Map<string, Promise<ProjectHost | null>>()
  private readonly registered = new Set<string>()
  private readonly lockDir: string

  /** M13-W3：项目上架监听器集（mux 层接——project/added 帧的源 + 动态接入新项目） */
  private readonly hostListeners = new Set<(cwd: string, host: ProjectHost) => void>()

  constructor(private readonly opts: ProjectHostOptions) {
    this.lockDir = opts.lockDir ?? join(homedir(), '.ecode', 'sessions')
  }

  /** M13-W3：订阅项目上架（返回退订；mux 连接用） */
  onHostAdded(cb: (cwd: string, host: ProjectHost) => void): () => void {
    this.hostListeners.add(cb)
    return () => this.hostListeners.delete(cb)
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
      return { ok: true, host: live }
    }

    // 冷启动单飞去重（并发 acquire 只装配一次）
    const inflight = this.pendingAcquire.get(cwd)
    if (inflight !== undefined) {
      const h = await inflight
      return h !== null ? { ok: true, host: h } : { ok: false, reason: 'locked' }
    }

    // deferred：先登记再去装配——promise 体同步失败时 delete 会先于 set 执行留下死条目（实测竞态）
    let settle!: (h: ProjectHost | null) => void
    const p = new Promise<ProjectHost | null>((res) => {
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
      this.pendingAcquire.delete(cwd)
      for (const cb of this.hostListeners) cb(cwd, host)
      settle(host)
    })()
    const h = await p
    return h !== null ? { ok: true, host: h } : { ok: false, reason: 'locked', lockHolder: '' }
  }

  /**
   * M13-W2 会话级回收（项目级 sweepIdle 退役——Q5 基座常驻不收，两家实证）：
   * 遍历项目宿主做会话 sweep（三闸：订阅者/挂起审批/运行态），返回总回收数。
   * 项目锁不释放（disposeAll 时的全量清理不变）。
   */
  sweepSessions(sessionIdleMinutes: number): number {
    let reclaimed = 0
    for (const host of this.hosts.values()) reclaimed += host.sweepSessions(sessionIdleMinutes)
    return reclaimed
  }

  disposeAll(): void {
    for (const [cwd, host] of this.hosts) {
      host.disposeAll()
      this.unlock(cwd)
    }
    this.hosts.clear()
  }
}
