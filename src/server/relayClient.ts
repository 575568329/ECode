/**
 * R2：daemon 侧 relay 出站客户端（M14 产品化线 R 方案 §6.3——daemon 纯出站，零入站监听新增）。
 *
 * 控制腿（一条）：拨 {hostBase}/tunnel/<hostId> → 4 步握手（hello/challenge/proof/ack）→
 *   代次+租约登记 → invite 管理 + conn-open 接收。租约到期前主动 rebind（同代接管），
 *   断线退避重连（1s→15s 抖动；4401=凭据错停泵、4409/4408=resume 作废下次 fresh）。
 * 数据腿（每手机连接一条）：按 conn-open 的一次性 ticket 拨 {hostBase}/tunnel-data/<connId>，
 *   之后与手机逐帧对传应用协议（见 DataLeg）——loopback 自 fetch 本 daemon 的 mux HTTP 端点，
 *   信封路由/会话三态/重放游标/凭据分级语义全部复用（零分发逻辑复制）。
 *
 * 凭据链路：手机 hello 携带 per-device secret（R1 配对）→ verifyAuth 注入（serveMulti 的
 *   CredentialStore）判定等级；该 secret 同时作为 loopback fetch 的 Bearer——daemon 侧
 *   一切既有栅栏（device 不可注册项目/枚举列表/stop）对中继链路自动生效。
 *
 * 明文裸窗披露：R3 交付前数据腿 JSON 明文经 relay（自部署形态用户即运营方）；R3 起强制
 *   E2EE（LegSession 换 e2ee 实现，本文件结构不变）。
 */
import WebSocket from 'ws'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { CredentialClass } from './credentials.js'
import { E2eeHostSession } from './e2ee.js'

export interface RelayClientOpts {
  /** relay 源（wss://nodetime.cn 或本地 ws://127.0.0.1:7092） */
  hostBase: string
  /** 手机段基址（缺省 hostBase 同源 + /ecode 前缀——nginx 约定；本地测试可显式给 7091） */
  phoneBase?: string
  hostId: string
  hostToken: string
  /** 多机区分名（hello 上报——在线徽标显示） */
  hostName: string
  appVersion: string
  daemonPort: number
  /** 凭据校验（serveMulti 的 CredentialStore.verify——R2 数据腿 hello 鉴权） */
  verifyAuth: (secret: string) => CredentialClass | null
  /** 单 host 数据腿并发上限（invite 泄漏/失控时资源面收敛） */
  maxLegs?: number
  /** 租约续期提前量上限毫秒（默认 20-40s 随机；测试缩时用） */
  renewMarginMs?: number
  /** R3：daemon 静态 E2EE 钥匙（loadOrCreateHostKeys——给了即数据腿强制加密，D4） */
  hostKeys?: { publicKeyB64: string; privateKeyB64: string }
  log?: (level: 'info' | 'warn' | 'error', event: string, payload?: Record<string, unknown>) => void
}

export interface RelayStatus {
  connected: boolean
  generation: number
  leaseExpiresAt: number
  activeLegs: number
  lastClose?: { code: number; reason: string }
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 15_000
const RENEW_MARGIN_MIN_MS = 3_000
const RENEW_MARGIN_JITTER_MS = 20_000
const REQ_TIMEOUT_MS = 5_000
const PROOF_DOMAIN = 'ecode-relay-host-proof'
const DEFAULT_MAX_LEGS = 8

/** 租约续期提前量：到期前 20-40s 随机（orca 60-120s 针对长租约；120s 租约等比缩放） */
const renewDelay = (leaseExpiresAt: number, marginMs = RENEW_MARGIN_JITTER_MS): number =>
  Math.max(RENEW_MARGIN_MIN_MS, leaseExpiresAt - Date.now() - (marginMs + Math.random() * marginMs))

export class RelayClient {
  private ws: WebSocket | null = null
  private creds: { generation: number; resumeSecret: string } | null = null
  private disposed = false
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private renewTimer: NodeJS.Timeout | null = null
  private readonly legs = new Map<WebSocket, DataLeg>()
  private readonly reqs = new Map<string, (v: unknown) => void>()
  private readonly opts: Required<Pick<RelayClientOpts, 'maxLegs'>> & RelayClientOpts
  status_: RelayStatus = { connected: false, generation: 0, leaseExpiresAt: 0, activeLegs: 0 }

  constructor(opts: RelayClientOpts) {
    this.opts = { ...opts, maxLegs: opts.maxLegs ?? DEFAULT_MAX_LEGS }
  }

  /** serveMulti 起来后回填（数据腿 loopback fetch 的端口与凭据校验面——start 前调用） */
  bindDaemon(port: number, verify: (secret: string) => CredentialClass | null): void {
    const o = this.opts as { daemonPort: number; verifyAuth: (s: string) => CredentialClass | null }
    o.daemonPort = port
    o.verifyAuth = verify
  }

  /** relay 登记的 hostId（pair offer relay 段用） */
  get hostId(): string {
    return this.opts.hostId
  }

  /** 手机数据腿接入 URL（pair offer 的 relay 段用）。
   *  phoneBase 必须显式（serveMain 缺省 server+'/ecode'）——不能从 hostBase 推导：
   *  本地双端口与 nginx 双前缀下二者无派生关系（审阅 P0：原 hostBase+'/ecode' 拼出死链） */
  get phoneConnectUrl(): string {
    if (this.opts.phoneBase === undefined || this.opts.phoneBase === '') {
      throw new Error('relay phoneBase 未配置——无法生成手机接入 URL（serveMain 应缺省 server+/ecode）')
    }
    return `${this.opts.phoneBase.replace(/\/$/, '')}/v1/connect/${this.opts.hostId}`
  }

  start(): void {
    if (this.disposed) return
    this.dial()
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.renewTimer !== null) clearTimeout(this.renewTimer)
    for (const [ws, leg] of this.legs) {
      leg.dispose()
      try {
        ws.close()
      } catch {
        /* 已关 */
      }
    }
    this.legs.clear()
    try {
      this.ws?.close(1000, 'disposed')
    } catch {
      /* 未连 */
    }
    this.ws = null
  }

  /** pair/设备管理面：向 relay 登记一条短时 invite（经控制腿，reqId 关联） */
  async createInvite(ttlMs: number): Promise<{ inviteToken: string; expiresAt: number }> {
    const ws = this.ws
    if (ws === null || ws.readyState !== WebSocket.OPEN) throw new Error('relay 未连接——invite 需控制腿在线')
    const reqId = randomUUID()
    const reply = await this.request(ws, { t: 'invite-create', inviteToken: randomBytes(24).toString('base64url'), ttlMs, reqId })
    const r = reply as { inviteToken?: string; expiresAt?: number }
    if (typeof r.inviteToken !== 'string' || typeof r.expiresAt !== 'number') throw new Error('relay invite 回执异常')
    return { inviteToken: r.inviteToken, expiresAt: r.expiresAt }
  }

  async revokeInvite(inviteToken: string): Promise<boolean> {
    const ws = this.ws
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false // relay 侧 invite 自带 TTL 兜底
    const reqId = randomUUID()
    const reply = await this.request(ws, { t: 'invite-revoke', inviteToken, reqId })
    return (reply as { revoked?: boolean }).revoked === true
  }

  status(): RelayStatus {
    return { ...this.status_, activeLegs: this.legs.size }
  }

  /** 吊销/凭据摘除的本地断腿：按 session.auth 比对关掉该凭据的全部数据腿并 abort 其订阅。
   *  与 relay 可达性解耦——控制腿闪断窗口内吊销也即时生效（relay 侧 revokeInvite 只是辅助） */
  disposeLegsByAuth(secret: string): number {
    let n = 0
    for (const [ws, leg] of this.legs) {
      if (leg.authOf() !== secret) continue
      leg.dispose()
      try {
        ws.close(4001, 'device revoked')
      } catch {
        /* 已关 */
      }
      this.legs.delete(ws)
      n++
    }
    return n
  }

  // ———————————————— 控制腿 ————————————————
  private dial(): void {
    if (this.disposed) return
    const url = `${this.opts.hostBase.replace(/\/$/, '')}/tunnel/${this.opts.hostId}`
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.opts.hostToken}` }, maxPayload: 64 * 1024 })
    this.ws = ws
    let helloed = false
    ws.on('open', () => {
      helloed = true
      ws.send(
        JSON.stringify({
          t: 'host-hello',
          v: 1,
          name: this.opts.hostName,
          appVersion: this.opts.appVersion,
          ...(this.creds !== null ? { previousGeneration: this.creds.generation, controlResumeSecret: this.creds.resumeSecret } : {}),
        }),
      )
    })
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.t === 'host-challenge') {
        const proof = createHmac('sha256', this.opts.hostToken)
          .update(`${PROOF_DOMAIN}\0${this.opts.hostId}\0${String(msg.challengeId)}\0${String(msg.nonce)}`)
          .digest('base64')
        ws.send(JSON.stringify({ t: 'host-challenge-ack', challengeId: msg.challengeId, proof }))
        return
      }
      if (msg.t === 'host-hello-ack') {
        this.attempt = 0
        this.creds = { generation: Number(msg.generation) || 0, resumeSecret: String(msg.controlResumeSecret) }
        this.status_ = { ...this.status_, connected: true, generation: this.creds.generation, leaseExpiresAt: Number(msg.leaseExpiresAt) || 0 }
        this.log('info', 'relay_control_up', { generation: this.creds.generation, leaseExpiresAt: this.status_.leaseExpiresAt })
        this.scheduleRenew()
        return
      }
      if (msg.t === 'conn-open') {
        // 审阅修复（开发席 P1-3）：连接级异常兜底——DataLeg 构造链（E2eeHostSession 的
        // createPrivateKey 等）同步抛会沿 void 的 async 拒绝上抛 unhandledRejection 崩 daemon。
        // 吞连接级异常记日志：该腿不建，绝不向上抛
        void this.dialDataLeg(String(msg.connId), String(msg.ticket)).catch((e: unknown) => {
          this.log('error', 'relay_dial_failed', { connId: msg.connId, message: e instanceof Error ? e.message : String(e) })
        })
        return
      }
      if (msg.t === 'conn-abort') {
        this.log('info', 'relay_conn_abort', { connId: msg.connId })
        return
      }
      if (msg.t === 'drain') {
        this.log('warn', 'relay_drain', { graceMs: msg.graceMs })
        return
      }
      if (msg.t === 'host-renewed') {
        this.status_.leaseExpiresAt = Number(msg.leaseExpiresAt) || 0
        this.scheduleRenew()
        return
      }
      if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: msg.ts ?? Date.now() }))
    })
    ws.on('close', (code, reason) => {
      this.status_ = { ...this.status_, connected: false, lastClose: { code, reason: reason.toString() } }
      this.clearRenew()
      // 数据腿不动：rebind（同代接管）下数据腿跨控制腿存活；换代由 relay 侧收割（4409 关腿），
      // relay 进程死则所有 socket 自然断——客户端主动杀腿反而打断「控制腿闪断」的手机连接
      if (this.ws === ws) this.ws = null
      if (this.disposed) return
      if (code === 4401) {
        // 凭据/证明被拒——重试无意义（配置错），留给用户修 config 后重启
        this.log('error', 'relay_auth_rejected', { code, reason: reason.toString() })
        return
      }
      if (code === 4409 || code === 4408) this.creds = null // 代次被顶/租约过期——下次 fresh（服务端已宣告旧连接作废）
      if (helloed && this.attempt === 0) this.log('warn', 'relay_control_down', { code, reason: reason.toString() })
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 5)) * (0.7 + Math.random() * 0.6)
      this.attempt++
      this.reconnectTimer = setTimeout(() => this.dial(), backoff)
    })
    ws.on('error', () => {
      /* close 随后到达——退避在 close 统一处理 */
    })
  }

  /** 租约续期：到期前主动 rebind（同代接管——重连即续租，orca 语义） */
  private scheduleRenew(): void {
    this.clearRenew()
    if (this.disposed || this.ws === null) return
    this.renewTimer = setTimeout(() => {
      const ws = this.ws
      if (ws === null) return
      this.log('info', 'relay_lease_renew', {})
      try {
        ws.close(4000, 'renew')
      } catch {
        /* 已关 */
      }
    }, renewDelay(this.status_.leaseExpiresAt, this.opts.renewMarginMs))
  }

  private clearRenew(): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer)
    this.renewTimer = null
  }

  private request(ws: WebSocket, frame: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reqId = String(frame.reqId)
      const timer = setTimeout(() => {
        ws.off('message', onMessage) // 超时不摘除=每次超时泄漏一个常驻 listener（审阅 P2）
        this.reqs.delete(reqId)
        reject(new Error('relay 请求超时'))
      }, REQ_TIMEOUT_MS)
      this.reqs.set(reqId, (v) => {
        clearTimeout(timer)
        resolve(v)
      })
      const onMessage = (raw: Buffer): void => {
        try {
          const msg = JSON.parse(raw.toString()) as { reqId?: string }
          if (msg.reqId !== reqId) return
        } catch {
          return
        }
        ws.off('message', onMessage)
        const r = this.reqs.get(reqId)
        this.reqs.delete(reqId)
        r?.(JSON.parse(raw.toString()))
      }
      ws.on('message', onMessage)
      ws.send(JSON.stringify(frame))
    })
  }

  // ———————————————— 数据腿 ————————————————
  private async dialDataLeg(connId: string, ticket: string): Promise<void> {
    if (this.disposed) return
    if (this.legs.size >= this.opts.maxLegs) {
      this.log('warn', 'relay_legs_full', { connId, active: this.legs.size })
      return
    }
    const url = `${this.opts.hostBase.replace(/\/$/, '')}/tunnel-data/${this.opts.hostId}/${connId}`
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.opts.hostToken}`, 'x-ecode-ticket': ticket },
      maxPayload: 1024 * 1024,
    })
    await new Promise<void>((resolve) => {
      ws.once('open', () => resolve())
      ws.once('error', () => resolve()) // relay 侧 attach deadline 自会收尾
      setTimeout(resolve, 10_000)
    })
    if (ws.readyState !== WebSocket.OPEN || this.disposed) {
      try {
        ws.close()
      } catch {
        /* 未开 */
      }
      return
    }
    const leg = new DataLeg(ws, this.opts, () => this.legs.delete(ws))
    this.legs.set(ws, leg)
    ws.on('close', () => {
      leg.dispose()
      this.legs.delete(ws)
      this.log('info', 'relay_leg_closed', { connId, active: this.legs.size })
    })
    this.log('info', 'relay_leg_open', { connId, active: this.legs.size })
  }

  private log(level: 'info' | 'warn' | 'error', event: string, payload?: Record<string, unknown>): void {
    this.opts.log?.(level, event, payload)
  }
}

/**
 * 数据腿应用会话：手机 ↔ daemon 的帧协议。LegSession 抽象把「握手+加解密」整块可换——
 * R2=plaintextSession（明文裸窗期），R3 换 e2eeSession（强制加密）后本类零改动。
 *
 * 帧（ready 后；R2 明文）：
 *   P→D {t:'cmd', id, project?, body}    → D→P {t:'res', id, status, json}（loopback POST /api[/p/x]/cmd）
 *   P→D {t:'sub', id, sessionId?, sinceSeq?} → D→P {t:'sub-ok', id} + {t:'frame', frame}…
 *   P→D {t:'unsub', id}                  → 停对应 SSE 泵
 *   P→D {t:'ping', t}                    → D→P {t:'pong', t}
 */
interface LegSession {
  /** ready 前逐帧驱动（明文 hello / R3 e2ee 握手）；返回 close 则立即断腿 */
  onHandshake(text: string): { ready: boolean; send?: string; close?: { code: number; reason: string } }
  decode(text: string): Record<string, unknown> | null
  encode(obj: unknown): string
  readonly auth: string
  /** 解密失败即断腿（e2ee：计数器失序/GCM 认证失败=不可恢复——明文形态容错跳过） */
  readonly failClose: boolean
}

function plaintextSession(verifyAuth: (secret: string) => CredentialClass | null): LegSession {
  const state = { auth: '' }
  return {
    get auth() {
      return state.auth
    },
    failClose: false,
    onHandshake(text) {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(text) as Record<string, unknown>
      } catch {
        return { ready: false, close: { code: 4401, reason: 'bad hello' } }
      }
      const secret = typeof msg.auth === 'string' ? msg.auth : ''
      if (secret === '' || verifyAuth(secret) === null) return { ready: false, close: { code: 4401, reason: 'auth rejected' } }
      state.auth = secret
      return { ready: true, send: JSON.stringify({ t: 'hello-ok' }) }
    },
    decode(text) {
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return null
      }
    },
    encode(obj) {
      return JSON.stringify(obj)
    },
  }
}

/** R3：强制 E2EE 会话工厂（D4——hostKeys 缺省仅限无钥匙的测试形态；生产 serveMain 恒给） */
function e2eeSession(hostKeys: { privateKeyB64: string }, verifyAuth: (secret: string) => CredentialClass | null): LegSession {
  const s = new E2eeHostSession(hostKeys.privateKeyB64, verifyAuth)
  return {
    get auth() {
      return s.auth
    },
    failClose: true,
    onHandshake: (text) => s.onHandshake(text),
    decode: (text) => s.decode(text),
    encode: (obj) => s.encode(obj),
  }
}

/** 数据腿单帧回复封装（auth 从不在回执中出现） */
class DataLeg {
  private ready = false
  private readonly session: LegSession
  private readonly subs = new Map<string, AbortController>()
  private dead = false

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: RelayClientOpts,
    private readonly onEnd: () => void,
  ) {
    // D4：hostKeys 在=强制 e2ee（手机 hello/凭据全走密文）；无=仅测试形态的明文 hello
    this.session = opts.hostKeys !== undefined ? e2eeSession(opts.hostKeys, opts.verifyAuth) : plaintextSession(opts.verifyAuth)
    ws.on('message', (raw) => this.onText(raw.toString()))
  }

  private send(obj: unknown): void {
    if (!this.dead && this.ws.readyState === WebSocket.OPEN) this.ws.send(this.session.encode(obj))
  }

  private rawSend(text: string): void {
    if (!this.dead && this.ws.readyState === WebSocket.OPEN) this.ws.send(text)
  }

  private onText(text: string): void {
    if (this.dead) return
    if (!this.ready) {
      const r = this.session.onHandshake(text)
      if (r.close !== undefined) {
        this.close(r.close.code, r.close.reason)
        return
      }
      if (r.send !== undefined) this.rawSend(r.send)
      if (r.ready) this.ready = true
      return
    }
    const frame = this.session.decode(text)
    if (frame === null) {
      if (this.session.failClose) this.close(4003, 'decrypt failed') // 严格计数器：错位/重放/篡改不可恢复
      return
    }
    void this.dispatch(frame)
  }

  private async dispatch(frame: Record<string, unknown>): Promise<void> {
    if (frame.t === 'ping') {
      this.send({ t: 'pong', ts: frame.ts ?? Date.now() })
      return
    }
    if (frame.t === 'unsub') {
      const id = String(frame.id)
      this.subs.get(id)?.abort()
      this.subs.delete(id)
      return
    }
    if (frame.t === 'cmd') return void this.onCmd(frame)
    if (frame.t === 'sub') return void this.onSub(frame)
  }

  /** 命令：loopback POST 复用 daemon 全部信封语义（响应原样回传 status+json） */
  private async onCmd(frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id ?? '')
    const project = typeof frame.project === 'string' && frame.project !== '' ? encodeURIComponent(frame.project) : null
    const path = project !== null ? `/api/p/${project}/cmd` : '/api/cmd'
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.daemonPort}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.auth}` },
        body: JSON.stringify(frame.body ?? {}),
        signal: AbortSignal.timeout(120_000), // compact 等重命令可达分钟级；prompt 是 ack 即返
      })
      const json = (await res.json().catch(() => ({ ok: false, error: `daemon 回执非 JSON（HTTP ${res.status}）` }))) as unknown
      this.send({ t: 'res', id, status: res.status, json })
    } catch (e) {
      this.send({ t: 'res', id, status: 502, json: { ok: false, error: e instanceof Error ? e.message : String(e) } })
    }
  }

  /** 事件订阅：loopback SSE（sessionId/sinceSeq 游标语义原样透传）→ 逐帧 {t:'frame'} */
  private async onSub(frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id ?? '')
    const params = new URLSearchParams({ canAnswer: '1' })
    if (typeof frame.sessionId === 'string' && frame.sessionId !== '') params.set('sessionId', frame.sessionId)
    if (typeof frame.sinceSeq === 'number' && Number.isFinite(frame.sinceSeq)) params.set('sinceSeq', String(frame.sinceSeq))
    const ac = new AbortController()
    // 审阅修复（开发席 P2）：同 id 重复订阅先 abort 旧控制器——原直接覆盖 Map 槽，旧 SSE
    // reader 循环跑到腿断（泄漏一条 loopback 连接+重复推帧）
    this.subs.get(id)?.abort()
    this.subs.set(id, ac)
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.daemonPort}/api/events.mux?${params.toString()}`, {
        headers: { authorization: `Bearer ${this.auth}` },
        signal: ac.signal,
      })
      if (res.status !== 200 || res.body === null) {
        this.send({ t: 'sub-err', id, status: res.status })
        this.subs.delete(id)
        return
      }
      this.send({ t: 'sub-ok', id })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done || this.dead) return
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.startsWith(': ping')) {
            // daemon mux 15s 心跳注释行 → app 级 ping 帧透传：喂中继数据腿看门狗（否则闲置
            // 75s 被当半开连接收割——审阅 P1）+消费 e2ee 计数器（保持双向时序活）
            this.send({ t: 'ping', ts: Date.now() })
            continue
          }
          if (!line.startsWith('data: ')) continue // event: 行对 WS 通道无意义
          try {
            this.send({ t: 'frame', frame: JSON.parse(line.slice(6)) })
          } catch {
            /* 非 JSON data 行跳过 */
          }
        }
      }
    } catch {
      /* abort/网络断——订阅自然终止 */
    } finally {
      this.subs.delete(id)
    }
  }

  /** session 建立时确立的凭据（disposeLegsByAuth 比对用） */
  authOf(): string {
    return this.session.auth
  }

  private get auth(): string {
    return this.session.auth
  }

  dispose(): void {
    this.dead = true
    for (const ac of this.subs.values()) ac.abort()
    this.subs.clear()
  }

  private close(code: number, reason: string): void {
    this.dispose()
    try {
      this.ws.close(code, reason)
    } catch {
      /* 已关 */
    }
    this.onEnd()
  }
}
