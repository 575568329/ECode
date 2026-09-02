/**
 * ecode-relay 服务端（M14 产品化线 R2 完整形态——orca 控制信道蓝本，自部署单 cell 简化版）。
 * 取代 R 线前置的 HTTP-over-WS 字节隧道（该形态 relay 可见全部明文且无代次/租约语义）。
 *
 * 拓扑（两个监听面，nginx 反代约定见 docs/规范 自部署指南）：
 *   手机段 127.0.0.1:RELAY_PHONE_PORT（nginx /ecode/ 剥前缀反代）
 *     - 静态托管 PWA 壳（RELAY_WEB_DIR 存在即挂——relay 形态手机只走 WS，资产由 relay 源出）
 *     - GET  /v1/connect/<hostId>   WS 升级（手机数据腿；invite 凭据）
 *     - GET  /v1/hosts/online?ids=  多机在线徽标（只回显调用方已知的 hostId——不枚举）
 *     - GET  /v1/health
 *   电脑段 127.0.0.1:RELAY_HOST_PORT（nginx /ecode-tunnel/ 剥前缀反代）
 *     - GET /tunnel/<hostId>        WS 升级（daemon 控制腿；Bearer REG_TOKEN+4 步握手）
 *     - GET /tunnel-data/<connId>   WS 升级（daemon 数据腿；一次性 connTicket）
 *     - POST /v1/assign             director 契约（自部署静态回显，REG_TOKEN 鉴权）
 *
 * 控制信道协议（JSON 文本帧；orca 同款语义）：
 *   C→S host-hello{v,name,appVersion,previousGeneration?,controlResumeSecret?}
 *   S→C host-challenge{challengeId,nonce}            ← daemon 回 HMAC 证明（REG_TOKEN 域绑定）
 *   C→S host-challenge-ack{challengeId,proof}
 *   S→C host-hello-ack{generation,controlResumeSecret,leaseExpiresAt,activeConnIds,pendingConnIds}
 *   C→S invite-create{inviteToken,ttlMs,reqId} / invite-revoke{inviteToken,reqId}
 *   S→C conn-open{connId,ticket} / conn-abort{connId}
 *   S→C drain{graceMs} / {t:'ping',t}（15s，客户端任何入站字节喂看门狗）
 *
 * 代次与租约（防旧连接复活——orca 蓝本）：generation 由服务端在 ack 分配；fresh hello（无 resume）
 * = 新代（generation+1，旧数据腿全收）；rebind（previousGeneration+controlResumeSecret 成对且租约
 * 未过期）= 同代接管存量连接（resumeSecret 轮换）；租约到期未续 → 4408 关控制腿，之后仅 fresh 可入。
 *
 * 数据腿：手机 WS ↔ daemon 数据腿逐帧原样转发（文本帧不解析——R3 E2EE 后 relay 只见密文信封，
 * 本文件对载荷零理解是设计约束不是偷懒）。attach 时限 60s（conn-open 后 daemon 未拨数据腿即弃）。
 *
 * 安全：REG_TOKEN 常量时比较；invite 短时限（cap 10.5min）+吊销即断活连接；WS subprotocol 承载
 * invite（浏览器 WebSocket 不能带 header，query 会进代理日志）；连接级静默看门狗（15s ping/75s 静默
 * 双侧同款）；多机在线查询轻限速。明文裸窗期（R3 前）中继可见数据腿 JSON——部署边界披露随方案 §2。
 *
 * 运行：RELAY_REG_TOKEN=xxx node server.cjs（Windows/Linux 同一文件；依赖仅 ws）
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { WebSocketServer } = require('ws')

// —— 常量（环境变量可调仅供测试缩时；生产缺省即 orca 实测值）——
const PHONE_PORT = Number(process.env.RELAY_PHONE_PORT ?? 7091)
const HOST_PORT = Number(process.env.RELAY_HOST_PORT ?? 7092)
const REG_TOKEN = process.env.RELAY_REG_TOKEN ?? ''
const LEASE_TTL_MS = Number(process.env.RELAY_LEASE_MS ?? 120_000)
const PING_MS = Number(process.env.RELAY_PING_MS ?? 15_000)
const SILENCE_KICK_MS = Number(process.env.RELAY_SILENCE_MS ?? 75_000)
const ATTACH_DEADLINE_MS = Number(process.env.RELAY_ATTACH_MS ?? 60_000)
const CHALLENGE_WINDOW_MS = 10_000
const INVITE_TTL_CAP_MS = 10 * 60_000 + 30_000 // orca MAX_INVITE_TTL 10min + 30s 时钟偏差
const PUBLIC_CONNECT_BASE = process.env.RELAY_PUBLIC_CONNECT_BASE ?? '' // e.g. wss://nodetime.cn/ecode
const WEB_DIR = process.env.RELAY_WEB_DIR ?? ''
const LOG_PATH = process.env.RELAY_LOG ?? 'relay.log'
const ONLINE_RATE_PER_MIN = 60

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`
  process.stdout.write(`${line}\n`)
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`)
  } catch {}
}

/** 常量时 token/proof 比较（对齐 src/server/credentials.ts 摘要范式） */
function constantEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/** host-proof：HMAC(REG_TOKEN, 域标签||hostId||challengeId||nonce)（R2 形态——自部署共享
 *  REG_TOKEN 的互证；orca 的非对称 host-proof 是多租户 cell 不持长期密钥时的形态） */
function hostProof(hostId, challengeId, nonce) {
  return crypto
    .createHmac('sha256', REG_TOKEN)
    .update(`ecode-relay-host-proof\0${hostId}\0${challengeId}\0${nonce}`)
    .digest('base64')
}

/**
 * hostId → 状态。generation 语义：0=尚无活代；fresh hello ack 时 +1。
 * active/pending 的数据腿在换代时全部收割（新代意味着旧 control 作废——orca 语义）。
 */
const hosts = new Map()

// ———————————————————— 电脑段（控制腿 + 数据腿接入） ————————————————————
const hostHttp = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'POST' && url.pathname === '/v1/assign') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (REG_TOKEN === '' || !constantEqual(token, REG_TOKEN)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, cellUrl: PUBLIC_CONNECT_BASE, assignmentEpoch: 1 }))
  }
  res.writeHead(426)
  res.end('websocket upgrade required')
})
const hostWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 })

hostHttp.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
  if (REG_TOKEN === '' || !constantEqual(token, REG_TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  // 数据腿：/tunnel-data/<hostId>/<connId> + 一次性 ticket（header 承载——Node 客户端可带 header）
  const ticket = String(req.headers['x-ecode-ticket'] ?? '')
  const md = /^\/tunnel-data\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname)
  if (md !== null) {
    const st = hosts.get(md[1])
    const connId = md[2]
    const pending = st?.pending.get(connId)
    if (st === undefined || pending === undefined || !constantEqual(ticket, pending.ticket)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      return socket.destroy()
    }
    return hostWss.handleUpgrade(req, socket, head, (ws) => attachDataLeg(st, connId, pending, ws))
  }
  // 控制腿：/tunnel/<hostId>
  const mc = /^\/tunnel\/([A-Za-z0-9._-]+)$/.exec(url.pathname)
  if (mc !== null) {
    return hostWss.handleUpgrade(req, socket, head, (ws) => beginControlHandshake(mc[1], ws))
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
  socket.destroy()
})

/** 控制腿握手状态机：hello → challenge → ack → hello-ack（10s 质询窗口，超时 4401） */
function beginControlHandshake(hostId, ws) {
  let hello = null
  let done = false
  const fail = (code, reason) => {
    if (done) return
    done = true
    try {
      ws.close(code, reason)
    } catch {}
  }
  const challengeTimer = setTimeout(() => fail(4401, 'challenge timeout'), CHALLENGE_WINDOW_MS)
  const onMessage = (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (done) return
    if (msg.t === 'host-hello' && hello === null) {
      if (typeof msg.v !== 'number') return fail(4401, 'bad hello')
      hello = msg
      const challengeId = crypto.randomBytes(8).toString('hex')
      const nonce = crypto.randomBytes(16).toString('base64')
      ws._challenge = { challengeId, nonce }
      send(ws, { t: 'host-challenge', challengeId, nonce })
      return
    }
    if (msg.t === 'host-challenge-ack' && hello !== null && ws._challenge !== undefined) {
      const { challengeId, nonce } = ws._challenge
      if (msg.challengeId !== challengeId) return fail(4401, 'challenge mismatch')
      if (!constantEqual(String(msg.proof ?? ''), hostProof(hostId, challengeId, nonce))) {
        return fail(4401, 'proof rejected')
      }
      clearTimeout(challengeTimer)
      ws.off('message', onMessage)
      activateControl(hostId, ws, hello)
    }
  }
  ws.on('message', onMessage)
  ws.on('close', () => clearTimeout(challengeTimer))
}

/** 质询通过后的代次裁决与登记 */
function activateControl(hostId, ws, hello) {
  const prev = hosts.get(hostId)
  const fresh = hello.previousGeneration === undefined || hello.controlResumeSecret === undefined
  if (prev === undefined) {
    const st = {
      hostId,
      name: typeof hello.name === 'string' ? hello.name : hostId,
      version: typeof hello.appVersion === 'string' ? hello.appVersion : '',
      control: ws,
      generation: 1,
      resumeSecret: newResumeSecret(),
      leaseDeadline: Date.now() + LEASE_TTL_MS,
      invites: new Map(),
      pending: new Map(),
      active: new Map(),
      nextConn: 1,
    }
    hosts.set(hostId, st)
    ackControl(st, ws)
    wireControl(st, ws)
    log(`host online: ${hostId} (gen ${st.generation}, fresh)`)
    return
  }
  const alive = prev.control !== null && prev.control.readyState === 1
  if (!fresh) {
    // rebind：代次+resume 成对且租约未过期 → 同代接管（存量数据腿保留）
    const valid =
      !prev.leaseExpired &&
      prev.generation === hello.previousGeneration &&
      constantEqual(String(hello.controlResumeSecret), prev.resumeSecret)
    if (!valid) {
      try {
        ws.close(4409, 'generation/resume mismatch')
      } catch {}
      log(`rebind rejected: ${hostId} (gen ${prev.generation} vs ${hello.previousGeneration}, expired=${!!prev.leaseExpired})`)
      return
    }
    if (alive) {
      // 同代重入（旧腿还活着——重连风暴/双进程）：旧腿让位
      try {
        prev.control.close(4000, 'replaced')
      } catch {}
    }
    prev.control = ws
    prev.resumeSecret = newResumeSecret()
    prev.leaseDeadline = Date.now() + LEASE_TTL_MS
    prev.leaseExpired = false
    prev.name = typeof hello.name === 'string' ? hello.name : prev.name
    prev.version = typeof hello.appVersion === 'string' ? hello.appVersion : prev.version
    ackControl(prev, ws)
    wireControl(prev, ws)
    log(`host rebind: ${hostId} (gen ${prev.generation} kept, active=${prev.active.size})`)
    return
  }
  // 抢位仲裁（审阅 P1）：旧 control 仍活且租约未过期=fresh hello 来自冒名/重复进程——拒之门外。
  // 正常重启场景旧 control 已死或租约已过，不受影响；接管权收归 rebind/租约到期两条既有路径
  if (alive && !prev.leaseExpired) {
    try {
      ws.close(4409, 'active host holds slot')
    } catch {}
    log(`fresh rejected (slot held): ${hostId} (gen ${prev.generation})`)
    return
  }
  // fresh hello：新代（旧 control 与全部数据腿作废——守护进程重启/丢失 resume 的形态）
  prev.generation += 1
  prev.resumeSecret = newResumeSecret()
  prev.leaseDeadline = Date.now() + LEASE_TTL_MS
  prev.leaseExpired = false
  prev.name = typeof hello.name === 'string' ? hello.name : prev.name
  prev.version = typeof hello.appVersion === 'string' ? hello.appVersion : prev.version
  if (alive) {
    try {
      prev.control.close(4000, 'replaced')
    } catch {}
  }
  for (const [connId, p] of prev.pending) {
    clearTimeout(p.timer)
    try {
      p.phone.close(4409, 'generation advanced')
    } catch {}
  }
  prev.pending.clear()
  for (const [connId, a] of prev.active) {
    try {
      a.phone.close(4409, 'generation advanced')
    } catch {}
    try {
      a.daemon.close(4409, 'generation advanced')
    } catch {}
  }
  prev.active.clear()
  prev.control = ws
  ackControl(prev, ws)
  wireControl(prev, ws)
  log(`host online: ${hostId} (gen ${prev.generation}, advanced${alive ? ', old control replaced' : ''})`)
}

function ackControl(st, ws) {
  send(ws, {
    t: 'host-hello-ack',
    generation: st.generation,
    controlResumeSecret: st.resumeSecret,
    leaseExpiresAt: st.leaseDeadline,
    activeConnIds: [...st.active.keys()],
    pendingConnIds: [...st.pending.keys()],
  })
}

function newResumeSecret() {
  return crypto.randomBytes(32).toString('base64url')
}

/** 控制腿消息面（质询后的常驻语义：invite 管理 + 看门狗） */
function wireControl(st, ws) {
  const watcher = startWatchdog(ws, () => {
    log(`control silent kicked: ${st.hostId}`)
    try {
      ws.terminate()
    } catch {}
  })
  ws.on('message', (raw) => {
    watcher.touch()
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.t === 'pong') return
    if (msg.t === 'invite-create') {
      // ttl<=0 = 持久 invite（设备凭据生命周期=吊销即终态；正数=短时 invite cap 10.5min——orca 语义保留）
      const ttl = Number(msg.ttlMs)
      const eff = ttl > 0 ? Math.min(INVITE_TTL_CAP_MS, ttl) : 0
      const token =
        typeof msg.inviteToken === 'string' && msg.inviteToken.length >= 24
          ? msg.inviteToken
          : crypto.randomBytes(24).toString('base64url')
      st.invites.set(token, { expiresAt: eff === 0 ? 0 : Date.now() + eff, conns: new Set() })
      send(ws, { t: 'invite-ok', reqId: msg.reqId, inviteToken: token, expiresAt: eff === 0 ? 0 : Date.now() + eff })
      return
    }
    if (msg.t === 'invite-revoke') {
      const inv = st.invites.get(String(msg.inviteToken))
      if (inv !== undefined) {
        st.invites.delete(String(msg.inviteToken))
        for (const connId of inv.conns) killConn(st, connId, 'invite revoked')
        send(ws, { t: 'invite-ok', reqId: msg.reqId, revoked: true })
      } else {
        send(ws, { t: 'invite-ok', reqId: msg.reqId, revoked: false })
      }
      return
    }
    if (msg.t === 'host-renew') {
      // 显式续租（正常路径是到期前 rebind——两种都认，租约推进即目标）
      st.leaseDeadline = Date.now() + LEASE_TTL_MS
      st.leaseExpired = false
      send(ws, { t: 'host-renewed', leaseExpiresAt: st.leaseDeadline, controlResumeSecret: st.resumeSecret })
      return
    }
  })
  // 服务器侧 ping（客户端任何入站字节喂看门狗；app 级 ping/pong 是 orca 语义）
  const pinger = setInterval(() => send(ws, { t: 'ping', ts: Date.now() }), PING_MS)
  pinger.unref()
  ws.on('close', () => {
    clearInterval(pinger)
    watcher.stop()
    if (st.control === ws) {
      st.control = null
      log(`host offline: ${st.hostId}`)
    }
  })
}

/** 手机段 pending 的数据腿拼装（ticket 已验） */
function attachDataLeg(st, connId, pending, ws) {
  clearTimeout(pending.timer)
  st.pending.delete(connId)
  const leg = { phone: pending.phone, daemon: ws }
  st.active.set(connId, leg)
  // 看门狗先行（消息转发路径里要喂狗——引用必须已就绪）
  leg.watch = startWatchdog(ws, () => {
    try {
      ws.terminate()
    } catch {}
    try {
      pending.phone.terminate()
    } catch {}
  })
  for (const frame of pending.buffer) ws.send(frame) // attach 前手机先行帧补投（原样文本）
  pending.buffer.length = 0
  ws.on('message', (raw) => {
    leg.watch.touch()
    forwardText(pending.phone, raw)
  })
  pending.phone.on('message', (raw) => {
    leg.watch.touch()
    forwardText(ws, raw)
  })
  const teardown = () => killConn(st, connId, 'leg closed')
  ws.on('close', teardown)
  pending.phone.on('close', teardown)
  log(`conn attached: ${st.hostId}/${connId} (active=${st.active.size})`)
}

function killConn(st, connId, why) {
  // 手机腿统一 4401：吊销/失效语义必须带码传达——无码(1000/1006)会让 web 端当成普通断线无限重连，
  // 永不回配对流（G-R1 验收面）
  const p = st.pending.get(connId)
  if (p !== undefined) {
    clearTimeout(p.timer)
    try {
      p.phone.close(4401, why)
    } catch {}
    st.pending.delete(connId)
  }
  const a = st.active.get(connId)
  if (a !== undefined) {
    try {
      a.phone.close(4401, why)
    } catch {}
    try {
      a.daemon.close()
    } catch {}
    st.active.delete(connId)
    if (a.watch !== undefined) a.watch.stop()
  }
}

// ———————————————————— 手机段（静态壳 + connect 数据腿 + 查询） ————————————————————
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}
const STATIC_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const phoneHttp = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, hosts: hosts.size }))
  }
  if (req.method === 'GET' && url.pathname === '/v1/hosts/online') {
    if (!rateAllow(req.socket.remoteAddress ?? '')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'rate limited' }))
    }
    const ids = String(url.searchParams.get('ids') ?? '')
      .split(',')
      .filter((s) => /^[A-Za-z0-9._-]{1,64}$/.test(s))
      .slice(0, 32)
    const out = {}
    for (const id of ids) {
      const st = hosts.get(id)
      out[id] = st !== undefined && st.control !== null && st.control.readyState === 1 && !st.leaseExpired
        ? { online: true, name: st.name, version: st.version }
        : { online: false }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ ok: true, hosts: out }))
  }
  // 静态 PWA 壳（RELAY_WEB_DIR 存在即挂；SPA fallback 同 daemon 形态）
  if (req.method === 'GET' && WEB_DIR !== '') {
    const rel = path.normalize(url.pathname).split(path.sep).filter((x) => x !== '..').join(path.sep)
    const candidate = rel === path.sep || rel === '' || rel === '\\' ? path.join(WEB_DIR, 'index.html') : path.join(WEB_DIR, rel)
    const file = candidate.startsWith(WEB_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(WEB_DIR, 'index.html')
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'content-security-policy': STATIC_CSP,
    })
    return fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res)
  }
  res.writeHead(404)
  res.end()
})

const phoneWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 })

phoneHttp.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const m = /^\/v1\/connect\/([A-Za-z0-9._-]+)$/.exec(url.pathname)
  if (m === null) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  const st = hosts.get(m[1])
  // invite 承载：浏览器 WebSocket 不能带 header——subprotocol 数组 ['ecode-relay', <token>]，
  // 非浏览器客户端可退 ?token=（短时单invite+吊销即断，泄露面有限）
  const protos = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const invite =
    protos.includes('ecode-relay') && protos.length > 1 ? protos[protos.indexOf('ecode-relay') + 1] : protos[0] || url.searchParams.get('token') || ''
  const inv = st !== undefined ? st.invites.get(invite) : undefined
  if (st === undefined || st.control === null || st.control.readyState !== 1) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n') // 线上形态：升级前拒绝只能 HTTP 层表达
    return socket.destroy()
  }
  if (inv === undefined || (inv.expiresAt !== 0 && inv.expiresAt <= Date.now())) {
    // 审阅修复（安全席 P2）：与 host 不在线同码 404——401/404 差异构成 hostId 在线枚举 oracle
    // （绕过 /v1/hosts/online 的限速与不枚举设计）
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  phoneWss.handleUpgrade(req, socket, head, (ws) => {
    const connId = `c${st.nextConn++}`
    const ticket = crypto.randomBytes(24).toString('hex')
    const entry = { phone: ws, ticket, buffer: [], watch: undefined, timer: undefined }
    // 审阅修复（安全席 P2）：pending 总数上限——静默连接在 attach 前每条挂 60s 计时+最多
    // 8MB 缓冲，无上限可内存放大 DoS（daemon 侧 maxLegs=8 只护对端）
    if (st.pending.size >= 32) {
      try {
        ws.close(4429, 'too many pending')
      } catch {}
      log(`pending cap hit: ${st.hostId} (>=32)`)
      return
    }
    st.pending.set(connId, entry)
    inv.conns.add(connId)
    entry.timer = setTimeout(() => {
      if (st.pending.get(connId) === entry) {
        st.pending.delete(connId)
        inv.conns.delete(connId)
        try {
          ws.close(4408, 'attach timeout')
        } catch {}
        send(st.control, { t: 'conn-abort', connId })
        log(`conn attach timeout: ${st.hostId}/${connId}`)
      }
    }, ATTACH_DEADLINE_MS)
    send(st.control, { t: 'conn-open', connId, ticket })
    ws.on('message', (raw) => {
      // attach 前的先行帧缓冲（e2ee 握手先于数据腿拼装是常态时序）
      if (st.pending.get(connId) === entry) {
        if (entry.buffer.length < 32 && raw.length <= 256 * 1024) entry.buffer.push(raw.toString())
        return
      }
    })
    ws.on('close', () => {
      clearTimeout(entry.timer)
      inv.conns.delete(connId)
      killConn(st, connId, 'phone closed')
    })
    log(`conn pending: ${st.hostId}/${connId}`)
  })
})

/** 手机消息转 daemon：文本帧原样转发（ws 类型校验在 maxPayload+文本假设下足够——二进制帧 toString 容错） */
function forwardText(target, raw) {
  if (target.readyState === 1) target.send(raw.toString())
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj))
}

// —— 静默看门狗（双侧镜像：任何入站字节喂狗；75s 静默收割半开/僵死 socket——orca 镜像边界）——
function startWatchdog(ws, onKick) {
  let last = Date.now()
  const onData = () => {
    last = Date.now()
  }
  ws.on('message', onData)
  ws.on('pong', onData)
  const iv = setInterval(() => {
    if (Date.now() - last > SILENCE_KICK_MS) onKick()
  }, PING_MS)
  iv.unref()
  return {
    touch,
    stop: () => clearInterval(iv),
  }
  function touch() {
    last = Date.now()
  }
}

// —— 轻限速（/v1/hosts/online；per-IP 分钟窗，防枚举探测）——
const rateMap = new Map()
function rateAllow(ip) {
  const now = Date.now()
  const e = rateMap.get(ip) ?? { n: 0, win: now }
  if (now - e.win > 60_000) {
    e.n = 0
    e.win = now
  }
  e.n++
  rateMap.set(ip, e)
  if (rateMap.size > 4096) rateMap.clear()
  return e.n <= ONLINE_RATE_PER_MIN
}

// —— 租约 sweep：到期未续（fresh/rebind 都算续）→ 关控制腿，此后仅 fresh hello 可入。
// 不设 control 存活前置：控制腿已断期间也要置位过期（否则旧 daemon 可凭 resumeSecret 跨租约窗复活）
setInterval(() => {
  const now = Date.now()
  for (const st of hosts.values()) {
    if (!st.leaseExpired && now > st.leaseDeadline) {
      st.leaseExpired = true
      if (st.control !== null) {
        try {
          st.control.close(4408, 'lease expired')
        } catch {}
      }
      log(`lease expired: ${st.hostId} (gen ${st.generation})`)
    }
  }
}, Math.min(5_000, PING_MS)).unref()

phoneHttp.listen(PHONE_PORT, '127.0.0.1', () => log(`phone on 127.0.0.1:${PHONE_PORT}${WEB_DIR !== '' ? ` (web ${WEB_DIR})` : ''}`))
hostHttp.listen(HOST_PORT, '127.0.0.1', () =>
  log(`host on 127.0.0.1:${HOST_PORT} (regToken ${REG_TOKEN === '' ? '未配置——拒绝接入' : '已配置'})`),
)
