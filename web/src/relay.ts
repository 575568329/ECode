/**
 * R2：web relay 传输——手机/PWA 经 relay 的 WS 数据腿连 daemon（异地形态）。
 *
 * 与 connect.ts 直连形态的契约对齐（sendCommand/connectMux/fetchProjects 同签名同语义），
 * connect.ts 各入口按 relayActive() 分流——App/Conversation/Composer 零感知切换。
 *
 * 语义对齐点（直连=fetch+SSE，中继=共享 WS）：
 * - 命令：{t:'cmd'} 帧 ↔ POST /api/p/x/cmd（401 同样清凭据回 token 门）；
 * - 事件：{t:'sub'} 帧（sessionId/sinceSeq 透传）↔ GET /api/events.mux——过滤/重放/gap 语义
 *   原样（App 的 W-9 游标逻辑不变）；WS 级断线重连 → onReconnect（触发 App 全量补拉）；
 * - 项目列表：device 凭据不可枚举（403 栅栏）——用配对时刻快照（offer.projects）。
 *
 * 配对深链：`#pairing=<base64url(offer)>`（fragment 不进代理日志）——consumePairingHash()
 * 在应用挂载前消费：写 relay 配置+token、剥 hash，App 直进已连接态。
 */

export interface RelayCfg {
  connectUrl: string
  inviteToken: string
  secret: string
  /** 配对的主机名（多机区分显示） */
  name?: string
  /** 配对时刻项目快照（device 凭据不可枚举项目列表——这是手机可见项目集） */
  projects?: string[]
  expiresAt?: number
  /** R3：daemon 静态公钥（offer pinning——防 relay MITM 换钥） */
  daemonPubKeyB64?: string
}

const RELAY_KEY = 'ecode-relay'

export function relayGetCfg(): RelayCfg | null {
  try {
    const raw = localStorage.getItem(RELAY_KEY)
    return raw !== null ? (JSON.parse(raw) as RelayCfg) : null
  } catch {
    return null
  }
}
export function relaySetCfg(c: RelayCfg): void {
  localStorage.setItem(RELAY_KEY, JSON.stringify(c))
}
export function relayClearCfg(): void {
  localStorage.removeItem(RELAY_KEY)
}
export function relayActive(): boolean {
  return relayGetCfg() !== null
}

/** #pairing= 深链消费（main.tsx 挂载前调用一次） */
export function consumePairingHash(): void {
  const m = /#pairing=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (m === null) return
  try {
    const offer = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as {
      secret?: string
      name?: string
      projects?: string[]
      webOrigin?: string
      relay?: { connectUrl?: string; hostId?: string; inviteToken?: string; expiresAt?: number }
      daemonPubKeyB64?: string
    }
    const relaySeg = offer.relay
    if (typeof offer.secret !== 'string' || offer.secret === '') return
    if (relaySeg === undefined || typeof relaySeg.connectUrl !== 'string' || typeof relaySeg.inviteToken !== 'string') return // 无 relay 段=局域网形态——走 token 门
    relaySetCfg({
      connectUrl: relaySeg.connectUrl,
      inviteToken: relaySeg.inviteToken,
      secret: offer.secret,
      name: offer.name,
      projects: Array.isArray(offer.projects) ? offer.projects : [],
      expiresAt: relaySeg.expiresAt,
      daemonPubKeyB64: offer.daemonPubKeyB64,
    })
    localStorage.setItem('ecode-token', offer.secret)
    history.replaceState(null, '', location.pathname + location.search)
  } catch {
    /* 坏链不理——token 门兜底 */
  }
}

// ———————————————— 共享 WS（命令+事件+连接态） ————————————————
type ConnState = 'connecting' | 'open' | 'backoff'

const stateListeners = new Set<(s: ConnState) => void>()
const reconnectListeners = new Set<() => void>()
const unauthorizedListeners = new Set<() => void>()
const frameListeners = new Set<(f: unknown) => void>()

let ws: WebSocket | null = null
let attempt = 0
let everConnected = false
let sessionReady = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const opQueue: Array<() => void> = [] // sessionReady 前的命令排队（握手先行）
const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let nextId = 1

function flushQueue(): void {
  while (opQueue.length > 0) opQueue.shift()?.()
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)) * (0.7 + Math.random() * 0.6)
  attempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, delay)
}

function connect(): void {
  const cfg = relayGetCfg()
  if (cfg === null) return
  stateListeners.forEach((l) => l('connecting'))
  // invite 走 subprotocol（浏览器 WS 不能带 header；query 会进代理日志）
  ws = new WebSocket(cfg.connectUrl, ['ecode-relay', cfg.inviteToken])
  ws.onopen = () => {
    sessionReady = false
    ws?.send(JSON.stringify({ t: 'hello', auth: cfg.secret }))
  }
  ws.onmessage = (e) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(e.data)) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.t === 'hello-ok') {
      const first = !everConnected
      const wasReconnect = everConnected
      everConnected = true
      attempt = 0
      sessionReady = true
      stateListeners.forEach((l) => l('open'))
      if (wasReconnect) reconnectListeners.forEach((l) => l())
      if (first || wasReconnect) flushQueue()
      return
    }
    if (msg.t === 'res') {
      const id = String(msg.id)
      const p = pending.get(id)
      if (p === undefined) return
      clearTimeout(p.timer)
      pending.delete(id)
      if (msg.status === 401) {
        clearCreds()
        unauthorizedListeners.forEach((l) => l())
        p.reject(new Error('未授权——设备连接已失效，请重新配对'))
        return
      }
      p.resolve((msg.json ?? {}) as Record<string, unknown>)
      return
    }
    if (msg.t === 'frame') {
      frameListeners.forEach((l) => l(msg.frame))
      return
    }
    if (msg.t === 'sub-err' && msg.status === 401) {
      clearCreds()
      unauthorizedListeners.forEach((l) => l())
    }
  }
  ws.onclose = (e) => {
    ws = null
    sessionReady = false
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已断开'))
    }
    pending.clear()
    if (e.code === 4401) {
      // invite 失效/被吊销：凭据全清——App 回门并提示重新配对
      clearCreds()
      unauthorizedListeners.forEach((l) => l())
      stateListeners.forEach((l) => l('backoff'))
      return
    }
    stateListeners.forEach((l) => l('backoff'))
    scheduleReconnect()
  }
  ws.onerror = () => {
    /* close 随后到——退避在 close 统一 */
  }
}

function ensureSocket(): void {
  if (relayGetCfg() === null) return
  if (ws !== null) {
    if (ws.readyState === WebSocket.OPEN && sessionReady) flushQueue()
    return
  }
  if (reconnectTimer !== null) {
    // 回前台加速重连（直连形态 visibilitychange 同款语义）
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  connect()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (ws === null || ws.readyState !== WebSocket.OPEN)) ensureSocket()
})

/** 吊销/失效：凭据全清（device secret + relay cfg——回配对流），留标记供 token 门提示重新配对 */
function clearCreds(): void {
  localStorage.removeItem('ecode-token')
  relayClearCfg()
  localStorage.setItem('ecode-relay-lost', '1')
  if (ws !== null) {
    try {
      ws.close()
    } catch {
      /* 已关 */
    }
    ws = null
  }
}

/** token 门提示（设备连接失效后——指引重新配对而非干输 token） */
export function relayLostMessage(): string | null {
  return localStorage.getItem('ecode-relay-lost') === '1' ? '设备连接已失效（被吊销或 invite 过期）——请在电脑端重新执行 ecode pair 配对' : null
}
export function clearRelayLost(): void {
  localStorage.removeItem('ecode-relay-lost')
}

// ———————————————— connect.ts 同构面 ————————————————
export function relaySendCommand(
  project: string,
  sessionId: string | undefined,
  op: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; sessionId?: string; value?: unknown; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    ensureSocket()
    opQueue.push(() => {
      if (ws === null || !sessionReady) {
        reject(new Error('中继连接不可用'))
        return
      }
      const id = `q${nextId++}`
      const body: Record<string, unknown> = { op }
      if (sessionId !== undefined && sessionId !== '') body.sessionId = sessionId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('命令超时（中继链路）'))
      }, 130_000)
      pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer })
      ws.send(JSON.stringify({ t: 'cmd', id, project, body }))
    })
    if (ws !== null && ws.readyState === WebSocket.OPEN && sessionReady) flushQueue()
  })
}

export function relayFetchProjects(): { registered: Array<{ path: string }>; active: Array<{ path: string }>; history: string[] } {
  const cfg = relayGetCfg()
  const projects = cfg?.projects ?? []
  return { registered: projects.map((p) => ({ path: p })), active: [], history: [] }
}

export function relayAddProject(): Promise<string> {
  return Promise.reject(new Error('设备连接不可添加项目（需用户级凭据——在电脑端操作）'))
}

export function relayFetchStats(): Promise<never> {
  return Promise.reject(new Error('设备连接不支持用量统计（需用户级凭据）'))
}

/** connectMux 同构：sub/unsub 帧 + WS 级重连通知（过滤/重放游标由 daemon 侧 mux 语义原样承担） */
export function relayConnectMux(
  handlers: {
    onFrame?: (f: unknown) => void
    onHost?: (h: unknown) => void
    onReconnect?: () => void
    onState?: (s: ConnState) => void
    onUnauthorized?: () => void
  },
  sessionId?: string,
  sinceSeq?: () => number | null,
): { dispose(): void } {
  let disposed = false
  const onFrame = (raw: unknown): void => {
    if (disposed) return
    const f = raw as { host?: unknown; [k: string]: unknown }
    if (f !== null && typeof f === 'object' && 'host' in f) handlers.onHost?.(f.host)
    else handlers.onFrame?.(raw)
  }
  frameListeners.add(onFrame)
  const onState = (s: ConnState): void => {
    if (!disposed) handlers.onState?.(s)
  }
  stateListeners.add(onState)
  const onReconnect = (): void => {
    if (!disposed) handlers.onReconnect?.()
  }
  reconnectListeners.add(onReconnect)
  const onUnauthorized = (): void => {
    if (!disposed) handlers.onUnauthorized?.()
  }
  unauthorizedListeners.add(onUnauthorized)

  // 订阅（socket ready 后；dispose 竞态守卫）
  let subId: string | null = null
  ensureSocket()
  opQueue.push(() => {
    if (disposed || ws === null || !sessionReady) return
    subId = `s${nextId++}`
    const since = sinceSeq?.()
    const frame: Record<string, unknown> = { t: 'sub', id: subId }
    if (sessionId !== undefined && sessionId !== '') frame.sessionId = sessionId
    if (since !== null && Number.isFinite(since)) frame.sinceSeq = since
    ws.send(JSON.stringify(frame))
  })
  if (ws !== null && ws.readyState === WebSocket.OPEN && sessionReady) flushQueue()

  return {
    dispose() {
      disposed = true
      frameListeners.delete(onFrame)
      stateListeners.delete(onState)
      reconnectListeners.delete(onReconnect)
      unauthorizedListeners.delete(onUnauthorized)
      if (subId !== null && ws !== null && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ t: 'unsub', id: subId }))
        } catch {
          /* 已断 */
        }
      }
    },
  }
}
