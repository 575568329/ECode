/**
 * M12-B8.2：多项目 serve——URL 前缀 /api/p/<encodeURIComponent(path)>/ 路由到对应项目宿主；
 * 无前缀=默认项目（serve 启动 cwd）。鉴权/loopback/工程细节包与单会话 serveHost 同款。
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { HostSession } from '../host/session.js'
import { serveHost, type ServeResult } from './http.js'
import type { ProjectRegistry } from './projects.js'

export interface MultiServeDeps {
  registry: ProjectRegistry
  defaultCwd: string
}

const MULTI_BODY_CAP = 1024 * 1024
const MULTI_LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 多项目 serve：基于单会话 serveHost 的鉴权/工程细节之外，加项目维度路由与 acquire 栅栏语义。
 * 返回与 ServeResult 同形（复用注册文件契约）。
 */
export function serveMulti(deps: MultiServeDeps, opts: { port?: number } = {}): Promise<ServeResult> {
  const token = randomBytes(24).toString('hex')
  const { registry } = deps

  const resolveHost = async (project: string | null, confirm: boolean): Promise<{ host: HostSession } | { error: string; code: number }> => {
    // 协议约定：项目路径一律正斜杠（Windows 反斜杠 %5C 会被 WHATWG URL 规范化为 / 碎段——实测坑）
    const cwd = project !== null ? decodeURIComponent(project).split(String.fromCharCode(92)).join('/') : deps.defaultCwd
    const r = await registry.acquire(cwd, { confirm })
    if (r.ok && r.host !== undefined) {
      registry.touch(cwd)
      return { host: r.host }
    }
    if (r.reason === 'need-confirm') return { error: '历史反推项目首次拉起需 confirm:true 二次确认（防恶意仓库 hooks）', code: 428 }
    if (r.reason === 'locked') return { error: '该项目正被其他进程占用（项目级互斥）', code: 409 }
    return { error: '项目路径不存在', code: 404 }
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const json = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      const remote = req.socket.remoteAddress ?? ''
      if (!MULTI_LOOPBACK.has(remote)) return json(403, { error: '非 loopback 连接被拒' })
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true })
      const auth = req.headers.authorization ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth.startsWith('Basic ') ? (Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':').pop() ?? '') : ''
      if (bearer !== token) return json(401, { error: '未授权' })

      // 项目列表
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return json(200, {
          registered: registry.listKnown(),
          active: registry.listActive(),
        })
      }

      // 项目维度路由：/api/p/:p/(cmd|events)；无前缀=默认项目
      const m = /^\/api\/(?:p\/([^/]+)\/)?(cmd|events)$/.exec(url.pathname)
      if (m === null) return json(404, { error: 'no route' })
      const project = m[1] ?? null
      const confirm = url.searchParams.get('confirm') === 'true' || url.searchParams.get('confirm') === '1'

      if (m[2] === 'cmd' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const c of req) {
              size += (c as Buffer).length
              if (size > MULTI_BODY_CAP) throw Object.assign(new Error('body 超限'), { statusCode: 413 })
              chunks.push(c as Buffer)
            }
            const cmd = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const h = await resolveHost(project, confirm)
            if ('error' in h) return json(h.code, { ok: false, error: h.error })
            json(200, await h.host.send(cmd as Parameters<HostSession['send']>[0]))
          } catch (e) {
            json((e as { statusCode?: number }).statusCode ?? 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        })()
        return
      }

      if (m[2] === 'events' && req.method === 'GET') {
        void (async () => {
          const h = await resolveHost(project, confirm)
          if ('error' in h) return json(h.code, { ok: false, error: h.error })
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          const unsub = h.host.subscribe((ev) => {
            if (res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`) === false) res.once('drain', () => {})
          })
          const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
          res.on('close', () => {
            clearInterval(ping)
            unsub()
          })
        })()
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
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        port,
        token,
        server,
        close: () =>
          new Promise((done) => {
            registry.disposeAll()
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}

/** 类型再导出（serveHost 契约锚点） */
export type { ServeResult }
void serveHost
