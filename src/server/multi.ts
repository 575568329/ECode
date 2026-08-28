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
import { isValidSessionId } from '../host/session.js'
import type { ProjectHost } from '../host/project.js'
import { randomUUID } from 'node:crypto'
import { LOOPBACK_ADDRS } from './loopback.js'
import { CredentialStore } from './credentials.js'
import { guardedSseWrite } from './sse.js'
import type { MuxFrame, SessionBrief } from '../protocol/mux.js'
import { FileHistoryStore, collectProjectCwds } from '../services/history.js'
import { aggregateStats } from '../services/stats.js'
import { homedir } from 'node:os'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { ServeResult } from './http.js'
import type { ProjectRegistry } from './projects.js'
import { normalizeProjectPath } from '../services/pathnorm.js'

export interface MultiServeDeps {
  registry: ProjectRegistry
  defaultCwd: string
}

const MULTI_BODY_CAP = 1024 * 1024

/**
 * M14-C2③：静态托管 CSP。img-src 需 data:（历史图片 base64 直渲）、blob:；
 * style-src 'unsafe-inline'（React 运行时 style 属性）；connect-src 同源 fetch+SSE。
 */
const STATIC_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"


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
    /** M14-C4④：stats 聚合缓存路径（缺省 ~/.ecode/stats-cache.json；测试注入 tmpdir 隔离真实 home） */
    statsCachePath?: string
    /** M13-W5：web/dist 托管目录（存在即挂 / 静态路由 + SPA fallback；缺省不挂） */
    webDir?: string
    /** M14-C2④：实例标识（/api/health 回显——serveStop kill 前比对防陈旧 PID 误杀） */
    id?: string
    /** M14-C2①/D13：追加凭据条目（device 级测试注入口；产品化线 R1 配对设备正式写入处） */
    extraCredentials?: Array<{ secret: string; class: 'primary' | 'lan-password' | 'device' }>
    /** F-27：POST /api/cmd {op:'stop'} 优雅停机回调（serveMode 注入——断 mux → flush 日志 → exit；
     *  缺省 501 NOT_IMPLEMENTED（测试/嵌入方未接线）。本机 token 持有者即主人，不需二次确认） */
    onStop?: () => Promise<void> | void
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
  // M13-W3（三预留①多凭据结构）+ M14-C2①（D13 凭据条目化）：token=primary、密码=lan-password
  // （同为一等信任——用户亲手设置）；product 线 R1 配对设备以 device 级追加（不可 confirm 豁免）。
  // 比较走 CredentialStore 常量时校验（digest+timingSafeEqual）；Basic 形态退役（审阅 P2 收敛——web 全 Bearer）
  const credentials = new CredentialStore()
  credentials.add(token, 'primary')
  if (opts.password !== undefined && opts.password !== '') credentials.add(opts.password, 'lan-password')
  for (const c of opts.extraCredentials ?? []) credentials.add(c.secret, c.class)
  const muxFilter = opts.muxFilter

  /** 新会话 id（cli 生成策略同款：ISO 时间戳 + 短随机尾防同秒碰撞） */
  const freshSessionId = (): string => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`

  /**
   * 信封三态路由（§3.2）。返回会话 + 其 id；错误：冷会话非 restore → 404。
   * body 一律信封 {op:{...}, sessionId?}（裸 ProtocolCommand 过渡兼容已随 W5 退役——审阅 B2 双轨清理）。
   */
  const routeConversation = async (
    host: ProjectHost,
    raw: Record<string, unknown>,
  ): Promise<{ conv: HostSession; sessionId: string } | { error: string; code: number }> => {
    const sessionId = raw.sessionId as string | undefined
    const op = (typeof raw.op === 'object' && raw.op !== null ? raw.op : {}) as { op: string }
    // 裸 ProtocolCommand 已退役（审阅 B2）——缺信封/缺 op 字符串一律 400 明示，不落 NOT_IMPLEMENTED 兜底
    if (typeof op.op !== 'string' || op.op === '') return { error: '信封缺少 op 字段（期望 {op:{...}, sessionId?}）', code: 400 }
    if (sessionId !== undefined && sessionId !== '') {
      const live = host.conversation(sessionId)
      if (live !== undefined) {
        // 活会话：Map 路由无文件面——任意形态 id 放行（测试/内部短 id 合法形态）
        host.touch(sessionId)
        return { conv: live, sessionId }
      }
      // 冷会话：直接 ensureRestore 拉起并作为路由结果（审阅 P0-3①：曾取 ensureDefault(fresh)
      // 当"载体会话"承载 restore 命令——冷项目凭空多出一个幻影空默认会话进列表广播；
      // restore 命令再发到自身 dispatch 时 ensureRestore 活复用幂等）
      if (op.op === 'session/restore') {
        // 审阅 P0-1：冷路径 sessionId 会拼进 `join(dir, id+'.jsonl')` 文件路径——白名单校验
        // （`..`/分隔符/绝对路径 = 任意 .jsonl 读写原语，LAN/R 线边界击穿）
        if (!isValidSessionId(sessionId)) return { error: `会话 id 非法：${sessionId}`, code: 400 }
        const conv = await host.ensureRestore(sessionId)
        host.touch(sessionId)
        return { conv, sessionId }
      }
      return { error: `会话 ${sessionId} 不存在（冷会话仅 session/restore 可拉起）`, code: 404 }
    }
    // 缺省：默认会话或隐式新建（三态②③）
    const conv = host.ensureDefault(freshSessionId())
    const sid = host.currentSessionId
    host.touch(sid)
    return { conv, sessionId: sid }
  }

  /** URL 项目段 → 规范 cwd（审阅 P1-2：normalizeProjectPath 同 registry 形态——realpath+正斜杠。
   *  原仅反斜杠替换，与 listActive() 的 realpath 形态永不相等 → 默认项目恒误判冷项目，running 注入失效） */
  const cwdOf = (project: string | null): string =>
    project !== null ? normalizeProjectPath(decodeURIComponent(project)) : normalizeProjectPath(deps.defaultCwd)

  const resolveHost = async (
    project: string | null,
    credClass: 'primary' | 'lan-password' | 'device' | null,
  ): Promise<{ host: ProjectHost } | { error: string; code: number }> => {
    const cwd = cwdOf(project)
    // M14-C2①：confirm 豁免不再由 `?confirm=true` 客户端自报（审阅 P1-7——对脚本化客户端护栏为零），
    // 改为凭据分级派生——一等凭据（primary/lan-password，用户亲手持有）即栅栏同意；device 级不放行
    const confirm = credClass === 'primary' || credClass === 'lan-password'
    const r = await registry.acquire(cwd, { confirm })
    if (r.ok && r.host !== undefined) return { host: r.host }
    if (r.reason === 'need-confirm') return { error: '历史反推项目首次拉起需 confirm:true 二次确认（防恶意仓库 hooks）', code: 428 }
    if (r.reason === 'assemble-failed') return { error: `项目装配失败：${r.errorMessage ?? '未知'}`, code: 500 }
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
      // M14-C2④：health 回显实例标识（serveStop kill 前比对——PID 回收复用防误杀）
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, id: opts.id ?? null })

      // M13-W5：静态托管（SPA 壳免鉴权——HTML/JS 无敏感内容，API 全鉴权；TokenGate 是应用层）
      if (opts.webDir !== undefined && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
        const rel = normalize(url.pathname).split(sep).filter((x) => x !== '..').join(sep)
        const candidate = join(opts.webDir, rel === sep || rel === '' ? 'index.html' : rel)
        // 路径逃逸守卫（normalize 后仍剥 .. 段）+ SPA fallback：不存在的一律 index.html
        const file = candidate.startsWith(opts.webDir) && existsSync(candidate) && statSync(candidate).isFile()
          ? candidate
          : join(opts.webDir, 'index.html')
        try {
          const stream = createReadStream(file)
          // open 失败是异步 emit，try 覆盖不到——无监听会走 uncaughtException 击落整个
          // daemon（审阅 P1-1：dist 重建竞态窗口/权限变化/文件被删）；headers 已发无法改状态码，销毁连接即可
          stream.on('error', () => res.destroy())
          res.writeHead(200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
            'content-security-policy': STATIC_CSP,
          })
          stream.pipe(res)
        } catch {
          res.writeHead(500)
          res.end()
        }
        return
      }
      // M14-C2①②：Bearer-only + CredentialStore 常量时校验（Basic 形态退役——审阅 P2 双凭据解析留一）
      const auth = req.headers.authorization ?? ''
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const credClass = credentials.verify(presented)
      if (credClass === null) return json(401, { error: '未授权' })

      // 项目列表（M13-W4 三源并集：显式注册 ∪ 活项目 ∪ 历史反推 meta.cwd——Web 打开即见本机所有有历史的项目）
      // 审阅 P1-1：读侧全局信息（本机全部项目路径）与写侧同级栅栏——device 凭据不可枚举
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        if (credClass === 'device') return json(403, { error: '设备凭据不可枚举项目列表（需用户级凭据）' })
        return json(200, {
          registered: registry.listKnown(),
          active: registry.listActive(),
          history: collectProjectCwds(opts.sessionsDir),
        })
      }

      // 用量统计（M14-C4④：宿主数据就绪 web 零消费——daemon 与 sessions 同机，聚合直读；
      // ?days=N 过滤 byDay 尾部窗口，缺省 7；缓存写 ~/.ecode/stats-cache.json 与 TUI /stats 同源）
      // 审阅 P1-1：topSessions 含 cwd/firstUser（用户 prompt 原文）——web 面板零消费，不外发；
      // device 凭据同栅栏（聚合含全部项目的用量分布）
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        if (credClass === 'device') return json(403, { error: '设备凭据不可查看用量统计（需用户级凭据）' })
        const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days') ?? 7) || 7))
        try {
          const agg = aggregateStats(opts.sessionsDir ?? join(homedir(), '.ecode', 'sessions'), opts.statsCachePath)
          return json(200, {
            ok: true,
            days,
            totals: agg.totals,
            mcpCalls: agg.mcpCalls,
            sessions: agg.sessions,
            costUnknownSessions: agg.costUnknownSessions,
            cacheHitRate: agg.cacheHitRate,
            byDay: agg.byDay.slice(-days),
            byModel: agg.byModel,
            byProject: agg.byProject,
          })
        } catch (e) {
          return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }

      // 项目添加（web 侧栏「+」）：注册即入列表（册上项目 acquire 免 confirm——projects.ts 三件套）。
      // 仅注册不冷起宿主——首条消息 acquire 才装配（冷启动语义不变）
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        void (async () => {
          try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const c of req) {
              size += (c as Buffer).length
              if (size > MULTI_BODY_CAP) throw Object.assign(new Error('body 超限'), { statusCode: 413 })
              chunks.push(c as Buffer)
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { path?: unknown }
            const path = body.path
            if (typeof path !== 'string' || path.trim() === '') return json(400, { ok: false, error: '缺少 path' })
            if (!existsSync(path)) return json(404, { ok: false, error: `路径不存在：${path}` })
            if (!statSync(path).isDirectory()) return json(400, { ok: false, error: `不是目录：${path}` })
            // M14-C2①：项目注册是一等凭据动作（device 级不放行——R 线配对设备不能替用户注册任意目录）
            if (credClass === 'device') return json(403, { ok: false, error: '设备凭据不可注册项目（需用户级凭据）' })
            return json(200, { ok: true, path: registry.register(path) })
          } catch (e) {
            json(400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        })()
        return
      }

      // M13-W3：mux 单流——一条 SSE 汇所有项目所有会话（HostEvent 生命周期帧 + 信封事件帧）。
      // M14-C1④：?sessionId= 过滤管线已兑现（只收该会话 ev 帧、host 生命周期帧照发）——客户端
      // 自报仅管线；强制过滤自凭据派生待 R 线（muxFilter 钩子预留①）。
      // 连接三连：baseline（活项目+活会话）→ pending 审批重放（HostSession.subscribe 自带）→ 持续广播
      if (req.method === 'GET' && url.pathname === '/api/events.mux') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        // M14-C2⑧：mux 观察型连接须声明 canAnswer=1 才计入审批 fail-closed 判定——
        // 否则任一常开仪表盘订阅就使 sensitive 门"零订阅者 fail-closed"退化为 15min 挂起（审阅 P1-8）
        const canAnswer = url.searchParams.get('canAnswer') === '1'
        // M14-C1④ per-client 过滤管线：?sessionId= 声明只收该会话的 ev 帧（host 生命周期帧照发）。
        // 仅管线不构成安全边界（客户端自报；强制过滤自凭据派生，依赖 C2① 分级，R 线兑现）
        const wantSid = url.searchParams.get('sessionId')
        const write = guardedSseWrite(res)
        const send = (frame: MuxFrame): void => {
          if (muxFilter !== undefined && !muxFilter(frame)) return
          if (wantSid !== null && wantSid !== '' && 'ev' in frame && frame.sessionId !== wantSid) return
          const eventName = 'host' in frame ? frame.host.type : frame.ev.type
          write(`event: ${eventName}\n\ndata: ${JSON.stringify(frame)}\n\n`)
        }
        const unsubs: Array<() => void> = []
        const attachProject = (cwd: string, host: ProjectHost): void => {
          for (const [sid, conv] of host.conversationsSnapshot()) {
            unsubs.push(conv.subscribe((ev) => send({ project: cwd, sessionId: sid, ev }), { canAnswer }))
          }
          // 新会话动态补订 ev 流（审阅 P2-2：曾只发生命周期帧不订阅——新会话 delta/approval 全丢，
          // 现网靠 web 切会话重订整条 SSE 的副作用兜住；补订后单连接自洽）
          unsubs.push(
            host.onSessionEvent((kind, info) => {
              if (kind === 'created') {
                send({ host: { type: 'session/created', brief: info.brief ?? { project: cwd, sessionId: info.sessionId, running: false, title: '', updatedAt: Date.now() } } })
                const conv = host.conversation(info.sessionId)
                if (conv !== undefined) unsubs.push(conv.subscribe((ev) => send({ project: cwd, sessionId: info.sessionId, ev }), { canAnswer }))
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
        const ping = setInterval(() => write(': ping\n\n'), 15_000)
        res.on('close', () => {
          clearInterval(ping)
          for (const u of unsubs) u()
        })
        return
      }

      // 项目维度路由：/api/p/:p/cmd；无前缀=默认项目。
      // M14-C2①：`?confirm=true` 客户端自报退役（豁免随凭据分级派生，见 resolveHost）——
      // 旧客户端仍发此参数被忽略（web 端恒带，无害）。
      // M14-C1②：per-project events 端点退役（mux 是唯一事件面——双轨 SSE 写点收敛为一）
      const m = /^\/api\/(?:p\/([^/]+)\/)?cmd$/.exec(url.pathname)
      if (m === null) {
        if (/^\/api\/(?:p\/[^/]+\/)?events$/.test(url.pathname)) {
          return json(410, { error: '单会话 events 端点已退役（M14-C1②）——事件流统一走 /api/events.mux' })
        }
        return json(404, { error: 'no route' })
      }
      const project = m[1] ?? null

      if (req.method === 'POST') {
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
            // F-27：stop 信封拦截（serve 进程级命令——不路由进任何会话；原形态走信封路由会
            // 落到会话 dispatch 的 NOT_IMPLEMENTED 兜底）。auth 已过（primary/lan-password 一等凭据）。
            const stopPeek = (typeof cmd.op === 'object' && cmd.op !== null ? cmd.op : {}) as { op?: string }
            if (stopPeek.op === 'stop') {
              if (opts.onStop === undefined) return json(501, { ok: false, error: 'stop 未接线（无 onStop 回调）', code: 'NOT_IMPLEMENTED' })
              // 先回执再停（响应写出后再拉连接——客户端能收到 ok）
              json(200, { ok: true, stopping: true })
              void Promise.resolve(opts.onStop()).catch(() => {})
              return
            }
            // M14-C1③ 浏览即装配收敛：session/list 是纯读浏览——冷项目走 history 静态读路径
            // （不 resolveHost→acquire，点过的项目不再全变常驻）；项目已活则照旧走宿主（running 态准确）
            const opPeek = (typeof cmd.op === 'object' && cmd.op !== null ? cmd.op : {}) as { op?: string }
            if (opPeek.op === 'session/list' && credClass !== 'device' && !registry.listActive().some((e) => e.path === cwdOf(project))) {
              const metas = FileHistoryStore.listMetas(opts.sessionsDir ?? join(homedir(), '.ecode', 'sessions'), cwdOf(project))
              return json(200, { ok: true, value: metas })
            }
            const h = await resolveHost(project, credClass)
            if ('error' in h) return json(h.code, { ok: false, error: h.error })
            // 项目级 session/new：真新建（区别于缺省路由的 ensureDefault 复用默认会话——
            // 「+新对话」两次进同一会话的病灶）。ensure 即挂活 + created 帧广播（mux 列表
            // 自动同步）；冷项目首个新会话顺位成默认（缺省路由随后命中），不额外起承载会话
            const opName = (typeof cmd.op === 'object' && cmd.op !== null ? cmd.op : {}) as { op?: string }
            if (opName.op === 'session/new') {
              const sid = freshSessionId()
              h.host.ensure(sid)
              h.host.touch(sid)
              return json(200, { ok: true, sessionId: sid })
            }
            const routed = await routeConversation(h.host, cmd)
            if ('error' in routed) return json(routed.code, { ok: false, error: routed.error })
            const inner = (typeof cmd.op === 'object' && cmd.op !== null ? cmd.op : {}) as Parameters<HostSession['send']>[0]
            const result = await routed.conv.send(inner)
            json(200, { ...result, sessionId: routed.sessionId })
          } catch (e) {
            json((e as { statusCode?: number }).statusCode ?? 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
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
