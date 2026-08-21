/**
 * M12-B7：宿主 HTTP 骨架（单会话版——多项目 ProjectRegistry 在 B8）。
 *
 * 工程细节包（harness 教训全量落地）：
 * - 断连检测挂 ServerResponse close（request close 在 body 读完即触发，会立刻误杀流）
 * - res.write false 时等 drain（慢消费者背压）
 * - 每请求 catch-all（单请求异常不杀进程）
 * - 心跳注释帧（15s）
 * - body cap（1MB 预检 413——prompt.images base64 的上限防线）
 * - daemon token（启动生成 random token；除 health 外全端点强制 Bearer/Basic 携带）
 * - loopback 判定逐请求 socket.remoteAddress 白名单（禁信代理头）
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { HostSession } from '../host/session.js'

const BODY_CAP = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export interface ServeResult {
  port: number
  token: string
  server: http.Server
  close(): Promise<void>
}

export function serveHost(host: HostSession, opts: { port?: number; hostname?: string } = {}): Promise<ServeResult> {
  const token = randomBytes(24).toString('hex')
  const hostname = opts.hostname ?? '127.0.0.1'

  const authorized = (req: http.IncomingMessage): boolean => {
    const auth = req.headers.authorization ?? ''
    if (auth.startsWith('Bearer ')) return auth.slice(7) === token
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
        return decoded === `ecode:${token}` || decoded === `:${token}`
      } catch {
        return false
      }
    }
    return false
  }

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > BODY_CAP) {
          reject(Object.assign(new Error('body 超限（1MB）'), { statusCode: 413 }))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      })
      req.on('error', reject)
    })

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const json = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }

      // loopback 判定：逐请求 socket 地址（禁信 X-Forwarded-For/Host——伪造防线）
      const remote = req.socket.remoteAddress ?? ''
      if (!LOOPBACK.has(remote)) {
        json(403, { error: '非 loopback 连接被拒（远程访问需显式 --hostname + token 鉴权）' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(200, { ok: true })
      }
      if (!authorized(req)) {
        return json(401, { error: '未授权（Bearer <token>，token 见 serve 启动输出/注册文件）' })
      }

      if (req.method === 'POST' && url.pathname === '/api/cmd') {
        void (async () => {
          try {
            const cmd = await readBody(req)
            const result = await host.send(cmd as Parameters<HostSession['send']>[0])
            json(200, result)
          } catch (e) {
            json((e as { statusCode?: number }).statusCode ?? 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        })()
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        // 订阅即重放 pending 可答帧（HostSession.subscribe 内含 broker.replayPending）
        const unsub = host.subscribe((ev) => {
          // 背压：write false 时挂起等 drain（慢消费者不无限缓冲）
          if (res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`) === false) {
            res.once('drain', () => {})
          }
        })
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
        res.on('close', () => {
          clearInterval(ping)
          unsub()
        })
        return
      }

      json(404, { error: 'no route' })
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
      } else res.end()
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, hostname, () => {
      const { port } = server.address() as { port: number }
      resolve({
        port,
        token,
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}
