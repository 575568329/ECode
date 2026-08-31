/**
 * ecode-relay 最小服务端（T 线配套——HTTP-over-WS 隧道；R 方案 §6.3 完整 relay 的前置形态）。
 *
 * 拓扑：
 *   手机浏览器 → nginx(443, /ecode/) → 本进程 web 桥(127.0.0.1:RELAY_WEB_PORT=7081)
 *                                        │ connId 多路复用（TCP 字节级 splice，HTTP 语义两端还原）
 *                                        ▼ WS 隧道（电脑出站连接；nginx /ecode-tunnel/ 反代此处）
 *   电脑 tunnel-client → 127.0.0.1:{daemonPort}（daemon 的 HTTP/SSE 原样穿透）
 *
 * 协议（WS 文本帧 JSON；payload base64）：
 *   桥→电脑 {t:'o', c:connId}            新 web 连接（电脑侧 dial daemon）
 *   电脑→桥  {t:'oc', c}                 dial 完成
 *   双向    {t:'d', c, d:base64}         字节
 *   双向    {t:'c', c}                   对端关闭
 *
 * 安全：隧道接入需 REG_TOKEN（防任意人占用 hostId）；手机段 TLS 由 nginx 承载；
 * daemon 的 Bearer token 端到端不变（relay 只转发字节，不解析 HTTP）。
 * 多台电脑=多个 hostId（/tunnel/<hostId> 路径区分）。
 *
 * 运行：REG_TOKEN=xxx node server.js
 */

const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const { WebSocketServer } = require('ws')

const WEB_PORT = Number(process.env.RELAY_WEB_PORT ?? 7081)
const TUNNEL_PORT = Number(process.env.RELAY_TUNNEL_PORT ?? 7082)
const REG_TOKEN = process.env.RELAY_REG_TOKEN ?? ''
const LOG_PATH = process.env.RELAY_LOG ?? 'relay.log'

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`
  process.stdout.write(`${line}\n`)
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`)
  } catch {}
}

/** hostId → ws（电脑隧道连接；后连踢先连——单 host 单活隧道） */
const hosts = new Map()

// —— 隧道接入（电脑侧；nginx /ecode-tunnel/ 反代此处，需 WS Upgrade 头）——
const tunnelHttp = http.createServer((req, res) => {
  res.writeHead(426)
  res.end('websocket upgrade required')
})
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

tunnelHttp.on('upgrade', (req, socket, head) => {
  const m = String(req.url).match(/^\/tunnel\/([A-Za-z0-9._-]+)/)
  const token = new URL(req.url, 'http://x').searchParams.get('token')
  if (m === null || REG_TOKEN === '' || token !== REG_TOKEN) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const hostId = m[1]
  wss.handleUpgrade(req, socket, head, (ws) => {
    const prev = hosts.get(hostId)
    if (prev !== undefined && prev.readyState === 1) prev.close(4000, 'replaced')
    hosts.set(hostId, ws)
    log(`tunnel up: ${hostId}`)
    /** connId → 电脑侧的 daemon socket */
    const socks = new Map()
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t === 'o' && typeof msg.c === 'string' && typeof msg.daemonAddr === 'string') {
        // web 桥的新连接：电脑侧 dial daemon
        const i = msg.daemonAddr.lastIndexOf(':')
        const sock = net.connect(Number(msg.daemonAddr.slice(i + 1)), msg.daemonAddr.slice(0, i) || '127.0.0.1', () => {
          send(ws, { t: 'oc', c: msg.c })
        })
        socks.set(msg.c, sock)
        sock.on('data', (buf) => send(ws, { t: 'd', c: msg.c, d: buf.toString('base64') }))
        sock.on('close', () => {
          socks.delete(msg.c)
          send(ws, { t: 'c', c: msg.c })
        })
        sock.on('error', () => sock.destroy())
        return
      }
      const sock = socks.get(msg.c)
      if (sock === undefined) return
      if (msg.t === 'd' && typeof msg.d === 'string') sock.write(Buffer.from(msg.d, 'base64'))
      else if (msg.t === 'c') {
        socks.delete(msg.c)
        sock.destroy()
      }
    })
    ws.on('close', () => {
      for (const sock of socks.values()) sock.destroy()
      if (hosts.get(hostId) === ws) hosts.delete(hostId)
      log(`tunnel down: ${hostId}`)
    })
  })
})

// —— web 桥（nginx /ecode/ 的上游；纯 TCP 字节转隧道）——
let nextConnId = 1
const webBridge = net.createServer((conn) => {
  const hostId = [...hosts.keys()][0] // 多机场景由 nginx 按路径分流后此处带 hostId；当前单桥全量路由
  const ws = hostId !== undefined ? hosts.get(hostId) : undefined
  if (ws === undefined || ws.readyState !== 1) {
    conn.destroy()
    return
  }
  const connId = `w${nextConnId++}`
  send(ws, { t: 'o', c: connId })
  conn.on('data', (buf) => send(ws, { t: 'd', c: connId, d: buf.toString('base64') }))
  conn.on('close', () => send(ws, { t: 'c', c: connId }))
  conn.on('error', () => conn.destroy())
  const onMsg = (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.c !== connId) return
    if (msg.t === 'd' && typeof msg.d === 'string') conn.write(Buffer.from(msg.d, 'base64'))
    else if (msg.t === 'c') conn.destroy()
  }
  ws.on('message', onMsg)
  conn.on('close', () => ws.off('message', onMsg))
})

webBridge.listen(WEB_PORT, '127.0.0.1', () => log(`web bridge on 127.0.0.1:${WEB_PORT}`))
tunnelHttp.listen(TUNNEL_PORT, '127.0.0.1', () =>
  log(`tunnel ws on 127.0.0.1:${TUNNEL_PORT} (regToken ${REG_TOKEN === '' ? '未配置——拒绝接入' : '已配置'})`),
)

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj))
}
