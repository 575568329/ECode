/**
 * M12-B8.2：多项目 serve——URL 前缀 /api/p/<encodeURIComponent(path)>/ 路由到对应项目宿主；
 * 无前缀=默认项目（serve 启动 cwd）。鉴权/loopback/工程细节包与单会话 serveHost 同款。
 *
 * M13-W2：命令信封三态路由（方案 §3.2）——body `{sessionId?, op}`（兼容裸 ProtocolCommand 到 W5）：
 * ①显式 sessionId → 路由指定会话（冷会话仅 session/restore 可拉起，其余 404）；
 * ②缺省+有默认会话 → 默认会话；③缺省+无默认 → 隐式建新默认（回执带 sessionId）。
 * events 端点带 ?sessionId=（缺省订阅默认会话；冷会话经 ensureRestore 拉起后订阅）。
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { HostSession } from '../host/session.js'
import type { ProjectHost } from '../host/project.js'
import { randomUUID } from 'node:crypto'
import { LOOPBACK_ADDRS } from './loopback.js'
import type { MuxFrame, SessionBrief } from '../protocol/mux.js'
import { collectProjectCwds } from '../services/history.js'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join as pathJoin, normalize, sep } from 'node:path'
import { serveHost, type ServeResult } from './http.js'
import type { ProjectRegistry } from './projects.js'

export interface MultiServeDeps {
  registry: ProjectRegistry
  defaultCwd: string
}

const MULTI_BODY_CAP = 1024 * 1024


/**
 * 多项目 serve：基于单会话 serveHost 的鉴权/工程细节之外，加项目维度路由与 acquire 栅栏语义。
 * 返回与 ServeResult 同形（复用注册文件契约）。
 */
export function serveMulti(
  deps: MultiServeDeps,
  opts: {
    port?: number
    host?: string
    password?: string
    muxFilter?: (frame: MuxFrame) => boolean
    sessionsDir?: string
    /** M13-W5：web/dist 托管目录（存在即挂 / 静态路由 + SPA fallback；缺省不挂） */
    webDir?: string
  } = {},
): Promise<ServeResult> {
  const token = randomBytes(24).toString('hex')
  const { registry } = deps
  // M13-W3（三预留③绑定语义显式化）：默认 loopback；非 loopback 强制密码（cli 侧同款双保险）
  const bindHost = opts.host ?? '127.0.0.1'
  const isLoopbackBind = bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost'
  if (!isLoopbackBind && (opts.password === undefined || opts.password === '')) {
    return Promise.reject(new Error('非 loopback 绑定必须设置密码（拒绝启动——防裸奔局域网）'))
  }
  // M13-W3（三预留①多凭据结构）：token 为首项，密码为第二项——M14 配对设备追加凭据条目即在此列表
  const credentials = new Set<string>([token, ...(opts.password !== undefined && opts.password !== '' ? [opts.password] : [])])
  const muxFilter = opts.muxFilter

  /** 新会话 id（cli 生成策略同款：ISO 时间戳 + 短随机尾防同秒碰撞） */
  const freshSessionId = (): string => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`

  /**
   * 信封三态路由（§3.2）。返回会话 + 其 id；错误：冷会话非 restore → 404。
   * body 解析：含顶层 op 字段=信封；否则裸 ProtocolCommand（过渡兼容，W5 移除）。
   */
  const routeConversation = async (
    host: ProjectHost,
    raw: Record<string, unknown>,
  ): Promise<{ conv: HostSession; sessionId: string } | { error: string; code: number }> => {
    const envelope = typeof raw.op === 'object' && raw.op !== null && 'op' in (raw.op as Record<string, unknown>)
    const sessionId = envelope ? (raw.sessionId as string | undefined) : undefined
    const op = (envelope ? raw.op : raw) as { op: string }
    if (sessionId !== undefined && sessionId !== '') {
      const live = host.conversation(sessionId)
      if (live !== undefined) {
        host.touch(sessionId)
        return { conv: live, sessionId }
      }
      // 冷会话：仅 restore 可拉起——命令由默认会话的 dispatch 承载（ensureConversation 端口
      // 落 ProjectHost.ensureRestore——与 TuiApp/进程内同一条命令路径）；其余命令指名不存在的会话=失联
      if (op.op === 'session/restore') {
        const carrier = host.ensureDefault(freshSessionId())
        host.touch(sessionId)
        return { conv: carrier, sessionId }
      }
      return { error: `会话 ${sessionId} 不存在（冷会话仅 session/restore 可拉起）`, code: 404 }
    }
    // 缺省：默认会话或隐式新建（三态②③）
    const conv = host.ensureDefault(freshSessionId())
    const sid = host.currentSessionId
    host.touch(sid)
    return { conv, sessionId: sid }
  }

  const resolveHost = async (project: string | null, confirm: boolean): Promise<{ host: ProjectHost } | { error: string; code: number }> => {
    // 协议约定：项目路径一律正斜杠（Windows 反斜杠 %5C 会被 WHATWG URL 规范化为 / 碎段——实测坑）
    const cwd = project !== null ? decodeURIComponent(project).split(String.fromCharCode(92)).join('/') : deps.defaultCwd
    const r = await registry.acquire(cwd, { confirm })
    if (r.ok && r.host !== undefined) return { host: r.host }
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
      if (!LOOPBACK_ADDRS.has(remote)) return json(403, { error: '非 loopback 连接被拒' })
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true })

      // M13-W5：静态托管（SPA 壳免鉴权——HTML/JS 无敏感内容，API 全鉴权；TokenGate 是应用层）
      if (opts.webDir !== undefined && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
        const rel = normalize(url.pathname).split(sep).filter((x) => x !== '..').join(sep)
        const candidate = pathJoin(opts.webDir, rel === sep || rel === '' ? 'index.html' : rel)
        // 路径逃逸守卫（normalize 后仍剥 .. 段）+ SPA fallback：不存在的一律 index.html
        const file = candidate.startsWith(opts.webDir) && existsSync(candidate) && statSync(candidate).isFile()
          ? candidate
          : pathJoin(opts.webDir, 'index.html')
        try {
          const stream = createReadStream(file)
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' })
          stream.pipe(res)
        } catch {
          res.writeHead(500)
          res.end()
        }
        return
      }
      const auth = req.headers.authorization ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth.startsWith('Basic ') ? (Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':').pop() ?? '') : ''
      if (!credentials.has(bearer)) return json(401, { error: '未授权' })

      // 项目列表（M13-W4 三源并集：显式注册 ∪ 活项目 ∪ 历史反推 meta.cwd——Web 打开即见本机所有有历史的项目）
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return json(200, {
          registered: registry.listKnown(),
          active: registry.listActive(),
          history: collectProjectCwds(opts.sessionsDir),
        })
      }

      // 项目添加（web 侧栏「+」）：注册即入列表（册上项目 acquire 免 confirm——projects.ts 三件套）。
      // 仅注册不冷起宿主——首条消息 acquire 才装配（冷启动语义不变）
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        void (async () => {
          try {
            const chunks: Buffer[] = []
            for await (const c of req) chunks.push(c as Buffer)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { path?: unknown }
            const path = body.path
            if (typeof path !== 'string' || path.trim() === '') return json(400, { ok: false, error: '缺少 path' })
            if (!existsSync(path)) return json(404, { ok: false, error: `路径不存在：${path}` })
            if (!statSync(path).isDirectory()) return json(400, { ok: false, error: `不是目录：${path}` })
            return json(200, { ok: true, path: registry.register(path) })
          } catch (e) {
            json(400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        })()
        return
      }

      // M13-W3：mux 单流——一条 SSE 汇所有项目所有会话（HostEvent 生命周期帧 + 信封事件帧）。
      // 连接三连：baseline（活项目+活会话）→ pending 审批重放（HostSession.subscribe 自带）→ 持续广播
      if (req.method === 'GET' && url.pathname === '/api/events.mux') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        // 预留②per-client 过滤钩子（当前 undefined=全放行；M14 配对设备接 per-device 会话订阅过滤）
        const send = (frame: MuxFrame): void => {
          if (muxFilter !== undefined && !muxFilter(frame)) return
          const eventName = 'host' in frame ? frame.host.type : frame.ev.type
          if (res.write(`event: ${eventName}\n\ndata: ${JSON.stringify(frame)}\n\n`) === false) {
            res.once('drain', () => {})
          }
        }
        const unsubs: Array<() => void> = []
        const attachProject = (cwd: string, host: ProjectHost): void => {
          for (const [sid, conv] of host.conversationsSnapshot()) {
            unsubs.push(conv.subscribe((ev) => send({ project: cwd, sessionId: sid, ev })))
          }
          // 新会话动态补订（sweep 收掉的会话 channel.dispose 自动停流——无需退订）
          unsubs.push(
            host.onSessionEvent((kind, info) => {
              if (kind === 'created') {
                send({ host: { type: 'session/created', brief: info.brief ?? { project: cwd, sessionId: info.sessionId, running: false, title: '', updatedAt: Date.now() } } })
              } else {
                send({ host: { type: 'session/removed', project: cwd, sessionId: info.sessionId } })
              }
            }),
          )
        }
        // 连接后新上架项目动态接入（project/added + 补订）
        unsubs.push(
          registry.onHostAdded((cwd, host) => {
            send({ host: { type: 'project/added', project: cwd } })
            attachProject(cwd, host)
          }),
        )
        // 连接三连之一：baseline（活项目全部已 live——acquire 走 live 复用同步路径）
        void (async () => {
          const projects: string[] = []
          const sessions: SessionBrief[] = []
          for (const entry of registry.listActive()) {
            const r = await registry.acquire(entry.path, { confirm: true }).catch(() => null)
            if (r !== null && r.ok && r.host !== undefined) {
              projects.push(entry.path)
              sessions.push(...r.host.briefs())
              attachProject(entry.path, r.host)
            }
          }
          send({ host: { type: 'session/baseline', projects, sessions } })
        })()
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
        res.on('close', () => {
          clearInterval(ping)
          for (const u of unsubs) u()
        })
        return
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
            const cmd = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
            const h = await resolveHost(project, confirm)
            if ('error' in h) return json(h.code, { ok: false, error: h.error })
            // 项目级 session/new：真新建（区别于缺省路由的 ensureDefault 复用默认会话——
            // 「+新对话」两次进同一会话的病灶）。ensure 即挂活 + created 帧广播（mux 列表
            // 自动同步）；冷项目首个新会话顺位成默认（缺省路由随后命中），不额外起承载会话
            const opName = (typeof cmd.op === 'object' && cmd.op !== null ? cmd.op : cmd) as { op?: string }
            if (opName.op === 'session/new') {
              const sid = freshSessionId()
              h.host.ensure(sid)
              h.host.touch(sid)
              return json(200, { ok: true, sessionId: sid })
            }
            const routed = await routeConversation(h.host, cmd)
            if ('error' in routed) return json(routed.code, { ok: false, error: routed.error })
            const inner = (typeof cmd.op === 'object' && cmd.op !== null ? cmd.op : cmd) as Parameters<HostSession['send']>[0]
            const result = await routed.conv.send(inner)
            json(200, { ...result, sessionId: routed.sessionId })
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
          // W2：?sessionId= 指定会话（冷会话 ensureRestore 拉起后订阅）；缺省=默认会话
          const wantSid = url.searchParams.get('sessionId')
          const target =
            wantSid !== null && wantSid !== ''
              ? h.host.conversation(wantSid) ?? (await h.host.ensureRestore(wantSid))
              : h.host.ensureDefault(freshSessionId())
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
          const unsub = target.subscribe((ev) => {
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
    server.listen(opts.port ?? 0, bindHost, () => {
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
