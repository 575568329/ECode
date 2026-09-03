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

import { WebE2eeSession } from './e2ee'

export interface RelayCfg {
  connectUrl: string
  /** relay 登记名（多机区分——切换/在线徽标用） */
  hostId?: string
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

// ———————————————— 多机管理面（R5）：配对主机列表 + 主动断开 ————————————————
const HOSTS_KEY = 'ecode-relay-hosts'

export interface HostEntry extends RelayCfg {
  hostId: string
  pairedAt: number
}

export function listHosts(): HostEntry[] {
  try {
    const raw = localStorage.getItem(HOSTS_KEY)
    return raw !== null ? (JSON.parse(raw) as HostEntry[]) : []
  } catch {
    return []
  }
}

export function upsertHostList(cfg: RelayCfg): void {
  if (cfg.hostId === undefined || cfg.hostId === '') return
  const hosts = listHosts().filter((h) => h.hostId !== cfg.hostId)
  hosts.unshift({ ...cfg, hostId: cfg.hostId, pairedAt: Date.now() })
  localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.slice(0, 16)))
}

/** 切换活跃主机（写活跃配置——调用方 reload 重挂 WS） */
export function activateHost(hostId: string): void {
  const target = listHosts().find((h) => h.hostId === hostId)
  if (target === undefined) return
  relaySetCfg(target)
  localStorage.setItem('ecode-token', target.secret)
}

export function removeHost(hostId: string): void {
  localStorage.setItem(HOSTS_KEY, JSON.stringify(listHosts().filter((h) => h.hostId !== hostId)))
}

/** relay 源 origin（在线查询用——connectUrl 派生） */
export function relayOrigin(cfg: RelayCfg): string {
  try {
    return new URL(cfg.connectUrl).origin
  } catch {
    return ''
  }
}

/** 多机在线徽标（/v1/hosts/online——只回显已知 hostId，无枚举面） */
export interface HostOnline {
  online: boolean
  name?: string
  version?: string
}
export async function fetchHostsOnline(): Promise<Record<string, HostOnline>> {
  const hosts = listHosts()
  if (hosts.length === 0) return {}
  const byOrigin = new Map<string, string[]>()
  for (const h of hosts) {
    const origin = relayOrigin(h)
    if (origin === '') continue
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), h.hostId])
  }
  const out: Record<string, HostOnline> = {}
  await Promise.all(
    [...byOrigin].map(async ([origin, ids]) => {
      try {
        const res = await fetch(`${origin}/v1/hosts/online?ids=${encodeURIComponent(ids.join(','))}`, { signal: AbortSignal.timeout(4000) })
        if (!res.ok) return
        const body = (await res.json()) as { hosts?: Record<string, HostOnline> }
        for (const [k, v] of Object.entries(body.hosts ?? {})) out[k] = v
      } catch {
        /* 单源失败=全部离线显示 */
      }
    }),
  )
  return out
}

/** 手机端主动断开设备连接（清凭据回 token 门） */
export function relayDisconnect(): void {
  localStorage.removeItem('ecode-token')
  relayClearCfg()
  markRelayLost('已断开设备连接——重新接入请在电脑端执行 ecode pair 配对')
  location.reload()
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
    const cfg: RelayCfg = {
      connectUrl: relaySeg.connectUrl,
      hostId: relaySeg.hostId ?? offer.name,
      inviteToken: relaySeg.inviteToken,
      secret: offer.secret,
      name: offer.name,
      // 防御性归一：offer.projects 曾是 listKnown 对象形态（{path}）——web 端全按字符串消费
      projects: (Array.isArray(offer.projects) ? offer.projects : [])
        .map((p: unknown) => (typeof p === 'string' ? p : (p as { path?: string } | null)?.path))
        .filter((p: unknown): p is string => typeof p === 'string' && p !== ''),
      expiresAt: relaySeg.expiresAt,
      daemonPubKeyB64: offer.daemonPubKeyB64,
    }
    relaySetCfg(cfg)
    upsertHostList(cfg)
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
let session: WebE2eeSession | null = null
let attempt = 0
let everConnected = false
let sessionReady = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const OP_QUEUE_CAP = 64
/** 审阅修复（开发席 P1-2）：排队项带 abort——丢弃路径（clearCreds flush(drop)/队满挤出）必须
 *  settle 外层 Promise，否则 UI 态（creating 等）永久挂起直到手动刷新 */
const opQueue: Array<{ run: () => void; abort: (e: Error) => void }> = [] // sessionReady 前的命令排队（握手先行）
/** 活动事件订阅（重连后重发——daemon 侧新 DataLeg 的 subs 是空的，不重发=实时流永久静默） */
const activeSubs = new Map<string, { sessionId?: string; sinceSeq?: () => number | null }>()
const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let nextId = 1

function flushQueue(drop = false): void {
  while (opQueue.length > 0) {
    const item = opQueue.shift()
    if (drop) {
      item?.abort(new Error('中继连接已失效——命令未发出（请重新连接后重试）'))
      continue
    }
    item?.run()
  }
  if (!drop && sessionReady && activeSubs.size > 0) {
    // 重连后重发订阅（sinceSeq 取最新游标——mux 重放语义原样生效，对齐直连「每次重连重拉 SSE」）
    for (const [id, sub] of activeSubs) {
      const since = sub.sinceSeq?.()
      const frame: Record<string, unknown> = { t: 'sub', id }
      if (sub.sessionId !== undefined && sub.sessionId !== '') frame.sessionId = sub.sessionId
      if (since !== null && Number.isFinite(since)) frame.sinceSeq = since
      sendFrame(frame)
    }
  }
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

/** R3（D4 强制）：出站帧统一走 e2ee 加密链（保序消费计数器） */
function sendFrame(obj: unknown): void {
  if (session === null) {
    ws?.send(JSON.stringify(obj))
    return
  }
  void session
    .encode(obj)
    .then((text) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(text)
    })
    .catch(() => {
      /* 加密失败=会话已废——close 收割 */
    })
}

function connect(): void {
  const cfg = relayGetCfg()
  if (cfg === null) return
  if (typeof cfg.daemonPubKeyB64 !== 'string' || cfg.daemonPubKeyB64 === '') {
    // D4：relay 形态强制 E2EE——配对信息缺公钥=不可连接（重新配对）。
    // 先清凭据再打专属标记（clearCreds 的通用提示不覆盖专属原因）
    clearCreds()
    markRelayLost('配对信息缺少端到端加密公钥——请在电脑端重新执行 ecode pair 配对')
    unauthorizedListeners.forEach((l) => l())
    return
  }
  stateListeners.forEach((l) => l('connecting'))
  // invite 走 subprotocol（浏览器 WS 不能带 header；query 会进代理日志）
  ws = new WebSocket(cfg.connectUrl, ['ecode-relay', cfg.inviteToken])
  session = null
  ws.onopen = () => {
    sessionReady = false
    // R3：e2ee 握手（明文只有 hello/ready 两个密钥交换帧——auth 起全密文）
    const s = new WebE2eeSession(cfg.daemonPubKeyB64!, cfg.secret)
    session = s
    void s
      .startHello()
      .then((hello) => {
        ws?.send(hello)
      })
      .catch(() => {
        try {
          ws?.close()
        } catch {
          /* 已断 */
        }
      })
  }
  ws.onmessage = (e) => {
    void onWireMessage(String(e.data))
  }
  ws.onclose = (e) => {
    ws = null
    session = null
    sessionReady = false
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已断开'))
    }
    pending.clear()
    if (e.code === 4401 || e.code === 4001 || e.code === 4003) {
      // invite 失效/被吊销（4401）或 e2ee 被拒（4001/4003）：凭据全清——App 回门并提示重新配对
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

/** 线上帧路由（握手段→e2ee 状态机；ready 后→解密分发） */
async function onWireMessage(text: string): Promise<void> {
  if (!sessionReady && session !== null) {
    try {
      const r = await session.onHandshakeFrame(text)
      if (r.send !== undefined && ws !== null && ws.readyState === WebSocket.OPEN) ws.send(r.send)
      if (r.ready === true) {
        const wasReconnect = everConnected
        everConnected = true
        attempt = 0
        sessionReady = true
        stateListeners.forEach((l) => l('open'))
        if (wasReconnect) reconnectListeners.forEach((l) => l())
        flushQueue()
      }
    } catch {
      try {
        ws?.close()
      } catch {
        /* 已断 */
      }
    }
    return
  }
  if (session === null) return
  const msg = await session.decode(text)
  if (msg === null) {
    // 严格计数器：解密失败不可恢复（重放/乱序/篡改）——fail-close
    try {
      ws?.close(4003, 'decrypt failed')
    } catch {
      /* 已断 */
    }
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

function enqueueOp(run: () => void, abort: (e: Error) => void): void {
  // 队满=连接长期不可用——最老项丢弃让位（丢弃必须 abort——settle 其外层 Promise）
  if (opQueue.length >= OP_QUEUE_CAP) opQueue.splice(0, 1)[0]?.abort(new Error('中继命令队列已满——最早命令被丢弃'))
  opQueue.push({ run, abort })
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

function markRelayLost(message: string): void {
  localStorage.setItem('ecode-relay-lost', message)
}

/** 吊销/失效：凭据全清（device secret + relay cfg——回配对流），留标记供 token 门提示重新配对 */
function clearCreds(): void {
  localStorage.removeItem('ecode-token')
  relayClearCfg()
  markRelayLost('设备连接已失效（被吊销或 invite 过期）——请在电脑端重新执行 ecode pair 配对')
  flushQueue(true) // 挂起命令全部落地（清空态丢弃——clearCreds 后连接永不再建，调用方超时兜底）
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
  return localStorage.getItem('ecode-relay-lost')
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
    enqueueOp(
      () => {
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
        sendFrame({ t: 'cmd', id, project, body })
      },
      (e) => reject(e), // 丢弃路径同步 settle（审阅修复——外层 Promise 永挂会锁死 creating 等 UI 态）
    )
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

  // 订阅（socket ready 后；dispose 竞态守卫）。subId 先占位注册进 activeSubs——重连重发靠这张表
  const subId = `s${nextId++}`
  activeSubs.set(subId, { sessionId, sinceSeq })
  ensureSocket()
  enqueueOp(
    () => {
      if (disposed || ws === null || !sessionReady) return
      const since = sinceSeq?.()
      const frame: Record<string, unknown> = { t: 'sub', id: subId }
      if (sessionId !== undefined && sessionId !== '') frame.sessionId = sessionId
      if (since !== null && Number.isFinite(since)) frame.sinceSeq = since
      sendFrame(frame)
    },
    () => {
      /* 订阅无外层 Promise——丢弃仅静默（activeSubs 表仍在，重连后重发覆盖） */
    },
  )
  if (ws !== null && ws.readyState === WebSocket.OPEN && sessionReady) flushQueue()

  return {
    dispose() {
      disposed = true
      frameListeners.delete(onFrame)
      stateListeners.delete(onState)
      reconnectListeners.delete(onReconnect)
      unauthorizedListeners.delete(onUnauthorized)
      activeSubs.delete(subId)
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        try {
          sendFrame({ t: 'unsub', id: subId })
        } catch {
          /* 已断 */
        }
      }
    },
  }
}
