/**
 * 电脑侧隧道客户端（与 relay/server.js 配对——HTTP-over-WS 隧道的电脑半桥）。
 *
 * 出站 WS 连 relay（免公网入站），把 relay 转来的 web 连接拨接到本机 daemon 端口：
 *   收 {t:'o', c} → dial 127.0.0.1:{daemonPort} → 回 {t:'oc', c}
 *   收 {t:'d', c} → daemon socket 写
 *   收 {t:'c', c} → daemon socket 销毁
 *   daemon 数据/关闭 → {t:'d'|'c', c} 回 relay
 *
 * 用法（daemon 已在跑的前提下）：
 *   node scripts/tunnel-client.cjs --server wss://nodetime.cn --hostId DESKTOP-X \
 *     --regToken <服务器 REG_TOKEN> [--daemonPort 自动读 server.json]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { WebSocket } = require('ws')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const server = arg('server', 'ws://127.0.0.1:7082')
const hostId = arg('hostId', os.hostname())
const regToken = arg('regToken', process.env.TUNNEL_REG_TOKEN ?? '')
const daemonPort = Number(arg('daemonPort', '0')) || readDaemonPort()

function readDaemonPort() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? os.homedir(), '.ecode', 'server.json'), 'utf8'))
    return reg.port
  } catch {
    return 0
  }
}

if (!daemonPort) {
  console.error('✗ daemon 端口未知（--daemonPort 或 ~/.ecode/server.json）')
  process.exit(1)
}
const daemonAddr = `127.0.0.1:${daemonPort}`

function connect() {
  // 默认经 nginx /ecode-tunnel/ 前缀（剥后 relay 收到 /tunnel/<hostId>）；--path 可覆盖
  const wsPath = arg('path', '/ecode-tunnel/tunnel')
  const url = `${server.replace(/\/$/, '')}${wsPath}/${encodeURIComponent(hostId)}`
  // token 走 header（对齐 web 端「token 落 URL query 属 OWASP 风险」决策——不进代理日志）
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${regToken}` } })
  /** connId → daemon socket */
  const socks = new Map()

  ws.on('open', () => console.log(`${new Date().toISOString()} tunnel connected: ${hostId} → ${server}`))
  ws.on('close', () => {
    console.log('tunnel closed——5s 后重连')
    for (const sock of socks.values()) sock.destroy()
    socks.clear()
    setTimeout(connect, 5000)
  })
  ws.on('error', (e) => console.error(`tunnel error: ${e.message}`))
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.t === 'o') {
      const sock = net.connect(daemonPort, '127.0.0.1', () => {
        send({ t: 'oc', c: msg.c })
      })
      socks.set(msg.c, sock)
      sock.on('data', (buf) => send({ t: 'd', c: msg.c, d: buf.toString('base64') }))
      sock.on('close', () => {
        socks.delete(msg.c)
        send({ t: 'c', c: msg.c })
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

  function send(obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj))
  }
}

connect()
