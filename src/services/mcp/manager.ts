/**
 * McpManager（M6 M1/M3.2/M4.2/M4.5）：按需连接 + 六态状态机 + 生命周期。
 *
 * 核心模型（M6-D15/D27）：
 *   - 注册与连接解耦——启动读 metadata cache 注册全部工具（零连接）；lazy 默认首调才连
 *   - lifecycle 四态（lazy/eager/keep-alive/lazy-keep-alive）决定启动连接与空闲策略
 *   - 状态机：not-connected / cached / connecting / connected / failed / disabled
 *     · failed 60s 自动过期降级（有缓存→cached，无→not-connected）+ 60s 退避（期内不再尝试）
 *     · abort（用户中断）≠ 故障——状态回退、不记退避
 *     · connecting 期间断开 → pendingDisconnect（连接落地即 close）
 *     · 死连接：execute 层捕获传输错误后调 markBroken（置 failed + 清句柄，下次调用自动重连）
 *
 * 可测性：时钟（now）与连接器（connectFn）构造注入；tick() 公开（30s 定时器只调它）。
 */

import type { McpServerConfig, McpServerEntry } from './config.js'
import { configHashOf, McpCache, type McpToolDef, type McpCacheEntry } from './cache.js'

/** 六态（M3.2）。 */
export type McpServerStatus =
  | 'not-connected'
  | 'cached'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'disabled'

/** manager 眼中的 client（SDK Client 的最小面；生产实现在 adapt.ts 包装，测试注入 fake）。 */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDef[] }>
  callTool(
    params: { name: string; arguments?: unknown },
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ content: McpContentItem[]; isError?: boolean }>
  close(): Promise<void>
}

/** tools/call 返回的 content 项（渲染分派在 adapt.ts renderContent）。 */
export interface McpContentItem {
  type: string
  text?: string
  uri?: string
  mimeType?: string
  blob?: string
  data?: string
}

/** 状态快照（/mcp 面板与 StatusBar 的数据源）。 */
export interface McpServerSnapshot {
  name: string
  status: McpServerStatus
  source: 'user' | 'project'
  type: 'stdio' | 'http'
  toolCount: number
  /** failed 时的错误与发生时间（面板错误展开用） */
  error?: string
  failedAgoSec?: number
  lifecycle: NonNullable<McpServerConfig['lifecycle']>
}

export interface McpStatusEvent {
  server: string
  status: McpServerStatus
}

/** 时间与定时参数（单测注入假时钟/超长间隔）。 */
export interface McpManagerOpts {
  now?: () => number
  /** failed 过期 ms（默认 60s） */
  failedTtlMs?: number
  /** 空闲默认超时 ms（lazy 默认 10min） */
  defaultIdleMs?: number
  /** 健康检查间隔 ms（默认 30s；unref） */
  healthIntervalMs?: number
  /** 连接工厂（生产=SDK transport 握手；测试注入） */
  connectFn?: (name: string, cfg: McpServerConfig, signal?: AbortSignal) => Promise<McpClientLike>
  /** tools/list 后的注册回调（adapt 层把 defs 变 Tool 注册进 Registry） */
  onTools?: (serverName: string, defs: McpToolDef[], cfg: McpServerConfig) => void
  /** 状态事件（TuiApp 订阅 → StatusBar/面板刷新） */
  onEvent?: (e: McpStatusEvent) => void
  /** 元数据缓存（默认 ~/.ecode/mcp-cache.json；测试注入） */
  cache?: McpCache
  logger?: { warn: (msg: string) => void }
}

const DEFAULT_FAILED_TTL = 60_000
const DEFAULT_IDLE_MS = 10 * 60_000
const DEFAULT_HEALTH_INTERVAL = 30_000

interface ServerState {
  name: string
  cfg: McpServerConfig
  source: 'user' | 'project'
  status: McpServerStatus
  client?: McpClientLike
  tools: McpToolDef[]
  hasCache: boolean
  failedAt?: number
  error?: string
  lastUsedAt: number
  inFlight: number
  connectPromise?: Promise<McpClientLike>
  pendingDisconnect?: boolean
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>()
  private readonly now: () => number
  private readonly failedTtlMs: number
  private readonly defaultIdleMs: number
  private readonly connectFn: NonNullable<McpManagerOpts['connectFn']>
  private readonly opts: McpManagerOpts
  private timer?: NodeJS.Timeout
  private stopped = false

  constructor(opts: McpManagerOpts = {}) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.failedTtlMs = opts.failedTtlMs ?? DEFAULT_FAILED_TTL
    this.defaultIdleMs = opts.defaultIdleMs ?? DEFAULT_IDLE_MS
    this.connectFn =
      opts.connectFn ??
      (() => {
        throw new Error('McpManager：未注入 connectFn（生产在 makeDeps 接 SDK 适配层）')
      })
  }

  /**
   * 启动：注册表初始化（cache 命中 → cached + 注册工具零连接；eager/keep-alive → 即连）。
   * 二段启动：项目级未批准时调用方只传已批准的条目（M4.1），批准后再 start 追加。
   */
  async start(entries: McpServerEntry[]): Promise<{ connected: number; failed: string[] }> {
    const failed: string[] = []
    let connected = 0
    for (const e of entries) {
      const cache = this.opts.cache
      const hash = configHashOf(e.cfg)
      const hit = cache?.get(e.name, hash)
      const st: ServerState = {
        name: e.name,
        cfg: e.cfg,
        source: e.source,
        status: e.cfg.enabled === false ? 'disabled' : hit !== undefined ? 'cached' : 'not-connected',
        tools: hit?.tools ?? [],
        hasCache: hit !== undefined,
        lastUsedAt: this.now(),
        inFlight: 0,
      }
      this.servers.set(e.name, st)
      if (st.status === 'cached') this.opts.onTools?.(e.name, st.tools, e.cfg)
      // 启动即连：eager / keep-alive（lazy 系零连接——cache miss 的 lazy 走 bootstrap 连一次拿清单）
      if (st.status !== 'disabled' && (e.cfg.lifecycle === 'eager' || e.cfg.lifecycle === 'keep-alive')) {
        try {
          await this.lazyConnect(e.name)
          connected++
        } catch {
          failed.push(e.name) // 启动失败不阻塞（容错），标 failed 走退避
        }
      } else if (st.status === 'not-connected' && e.cfg.lifecycle == null) {
        // lazy + 无缓存：bootstrap 连一次拿清单（连上即注册，随后按空闲策略）
        void this.lazyConnect(e.name).catch(() => {})
      }
    }
    this.startTimer()
    return { connected, failed }
  }

  /** 30s 定时器（unref 不阻退出）：keep-alive 重连 + 空闲卸载 + failed 过期。 */
  private startTimer(): void {
    if (this.timer !== undefined || this.stopped) return
    const interval = this.opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL
    if (interval <= 0) return // 测试可关
    this.timer = setInterval(() => this.tick(), interval)
    this.timer.unref?.()
  }

  tick(): void {
    for (const st of this.servers.values()) {
      // ① keep-alive 系未连接 → 重连（退避期内跳过）
      const ka = st.cfg.lifecycle === 'keep-alive' || st.cfg.lifecycle === 'lazy-keep-alive'
      if (ka && st.status !== 'connected' && st.status !== 'disabled' && st.status !== 'connecting') {
        if (!this.inBackoff(st)) void this.lazyConnect(st.name).catch(() => {})
        continue
      }
      // ② 非 keep-alive：空闲超时且无在飞调用 → 断开（回 cached，工具注册保留）。
      //    idleTimeout 单位分钟：lazy 默认 10；eager 系默认 0=不断开（M3.1）
      if (!ka && st.status === 'connected') {
        const defaultMin = st.cfg.lifecycle === 'eager' ? 0 : this.defaultIdleMs / 60_000
        const idleMs = (st.cfg.idleTimeout ?? defaultMin) * 60_000
        if (idleMs > 0 && this.now() - st.lastUsedAt > idleMs && st.inFlight === 0) {
          void this.close(st.name).catch(() => {})
        }
      }
      // ③ failed 过期：60s 后降级（有缓存→cached / 无→not-connected）
      if (st.status === 'failed' && st.failedAt !== undefined && this.now() - st.failedAt > this.failedTtlMs) {
        st.status = st.hasCache ? 'cached' : 'not-connected'
        st.failedAt = undefined
        this.emit(st)
      }
    }
  }

  private inBackoff(st: ServerState): boolean {
    return st.failedAt !== undefined && this.now() - st.failedAt < this.failedTtlMs
  }

  private readonly listeners = new Set<(e: McpStatusEvent) => void>()

  private emit(st: ServerState): void {
    const e: McpStatusEvent = { server: st.name, status: st.status }
    this.opts.onEvent?.(e)
    for (const cb of this.listeners) cb(e)
  }

  /** 订阅状态事件（TuiApp：onEvent → setState → StatusBar/面板重渲染读 status() 快照）。 */
  subscribe(cb: (e: McpStatusEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * 按需连接（M4.2）：并发去重（共享 Promise）+ 60s 退避 + abort 例外 +
   * 成功后 refreshMetadata（tools/list → 注册 → 回写 cache）+ pendingDisconnect。
   */
  async lazyConnect(name: string, signal?: AbortSignal): Promise<McpClientLike> {
    const st = this.servers.get(name)
    if (st === undefined) throw new Error(`MCP server「${name}」未配置`)
    if (st.status === 'disabled') throw new Error(`MCP server「${name}」已禁用`)
    if (st.status === 'connected' && st.client !== undefined) return st.client
    if (st.connectPromise !== undefined) return st.connectPromise
    if (this.inBackoff(st)) {
      const ago = Math.round((this.now() - (st.failedAt ?? this.now())) / 1000)
      throw new Error(`MCP server「${name}」连接失败（${ago} 秒前），可 /mcp reconnect ${name}`)
    }
    st.status = 'connecting'
    this.emit(st)
    st.connectPromise = (async () => {
      try {
        const client = await this.connectFn(name, st.cfg, signal)
        await this.refreshMetadata(st, client)
        st.client = client
        st.status = 'connected'
        st.failedAt = undefined
        st.error = undefined
        st.lastUsedAt = this.now()
        this.emit(st)
        if (st.pendingDisconnect) {
          st.pendingDisconnect = false
          await this.close(name).catch(() => {})
        }
        return client
      } catch (e) {
        if (signal?.aborted) {
          // 用户中断 ≠ 故障：状态回退、不记退避（v6 审阅）
          st.status = st.hasCache ? 'cached' : 'not-connected'
          this.emit(st)
          throw e
        }
        st.failedAt = this.now()
        st.status = 'failed'
        st.error = e instanceof Error ? e.message : String(e)
        this.emit(st)
        throw e
      } finally {
        st.connectPromise = undefined
      }
    })()
    return st.connectPromise
  }

  /** tools/list → 更新 defs + 注册回调 + 回写 cache（串行队列）。MVP 只增注册不减注销。 */
  private async refreshMetadata(st: ServerState, client: McpClientLike): Promise<void> {
    const { tools } = await client.listTools()
    st.tools = tools
    st.hasCache = true
    this.opts.onTools?.(st.name, tools, st.cfg)
    const entry: McpCacheEntry = { configHash: configHashOf(st.cfg), tools, cachedAt: this.now() }
    await this.opts.cache?.set(st.name, entry)
  }

  /** 执行前取句柄（adapt 层的 getClient 惰性入口）。 */
  async getClientFor(name: string, signal?: AbortSignal): Promise<McpClientLike> {
    const client = await this.lazyConnect(name, signal)
    this.touch(name)
    return client
  }

  /** 每次工具调用刷新活跃时间（空闲卸载判定）。 */
  touch(name: string): void {
    const st = this.servers.get(name)
    if (st !== undefined) st.lastUsedAt = this.now()
  }

  /** 死连接标记（M4.4：adapt 层捕获传输错误后调用——置 failed + 清句柄，下次调用自动重连）。 */
  markBroken(name: string, error: string): void {
    const st = this.servers.get(name)
    if (st === undefined || st.status !== 'connected') return
    st.client = undefined
    st.status = 'failed'
    st.error = error
    st.failedAt = this.now()
    this.emit(st)
  }

  /** 手动断开（面板「断开」）：close → 状态回 cached（工具注册保留）。 */
  async close(name: string): Promise<void> {
    const st = this.servers.get(name)
    if (st === undefined) return
    if (st.status === 'connecting') {
      st.pendingDisconnect = true // 在飞连接不可取消：落地即关（v6 审阅）
      return
    }
    if (st.client !== undefined) {
      await st.client.close().catch(() => {})
      st.client = undefined
    }
    st.status = st.hasCache ? 'cached' : 'not-connected'
    this.emit(st)
  }

  /**
   * 手动重连（/mcp reconnect；面板 ctrl+r/「重连」）：清退避 → close → connect → 刷新 cache。
   * @param name 省略 = 全部非 disabled
   */
  async reconnect(name?: string): Promise<{ ok: string[]; failed: { name: string; error: string }[] }> {
    const targets = name !== undefined ? [name] : [...this.servers.keys()]
    const ok: string[] = []
    const failed: { name: string; error: string }[] = []
    for (const n of targets) {
      const st = this.servers.get(n)
      if (st === undefined || st.status === 'disabled') continue
      st.failedAt = undefined // 清退避（用户明确要求重试）
      await this.close(n).catch(() => {})
      try {
        await this.lazyConnect(n)
        ok.push(n)
      } catch (e) {
        failed.push({ name: n, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { ok, failed }
  }

  /** 状态快照（面板/StatusBar 数据源；failedAgoSec 供错误展开）。 */
  status(): McpServerSnapshot[] {
    return [...this.servers.values()].map((st) => ({
      name: st.name,
      status: st.status,
      source: st.source,
      type: st.cfg.type,
      toolCount: st.tools.length,
      ...(st.error !== undefined ? { error: st.error } : {}),
      ...(st.failedAt !== undefined ? { failedAgoSec: Math.round((this.now() - st.failedAt) / 1000) } : {}),
      lifecycle: st.cfg.lifecycle ?? 'lazy',
    }))
  }

  getServerConfig(name: string): McpServerConfig | undefined {
    return this.servers.get(name)?.cfg
  }

  /** server 的工具清单（面板三级视图用）。 */
  toolsOf(name: string): McpToolDef[] {
    return this.servers.get(name)?.tools ?? []
  }

  /** 在飞 server 列表名（StatusBar 统计用）。 */
  serverNames(): string[] {
    return [...this.servers.keys()]
  }

  /** 在飞计数（adapt 层 execute 前后加减；空闲卸载不切在飞调用）。 */
  beginCall(name: string): void {
    const st = this.servers.get(name)
    if (st !== undefined) st.inFlight++
  }

  endCall(name: string): void {
    const st = this.servers.get(name)
    if (st !== undefined) st.inFlight = Math.max(0, st.inFlight - 1)
  }

  /** 退出清理（exit handler 调；全部 close，不留孤儿）。 */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const st of this.servers.values()) {
      if (st.client !== undefined) await st.client.close().catch(() => {})
      st.client = undefined
      if (st.status === 'connected') {
        st.status = st.hasCache ? 'cached' : 'not-connected'
      }
    }
  }
}
