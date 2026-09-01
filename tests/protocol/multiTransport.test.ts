/**
 * T4 MultiTransport 契约测试：附着形态的 multi 信封传输（TuiApp↔daemon）。
 * 真 http server 验证——信封形态/帧分发过滤/seq 游标/401 停泵。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import * as http from 'node:http'
import { MultiTransport } from '../../src/protocol/multiTransport.js'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void

async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void>; sseClients: http.ServerResponse[] }> {
  const sseClients: http.ServerResponse[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      if (req.url?.includes('/api/events.mux')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(':open\n\n')
        sseClients.push(res)
        return
      }
      handler(req, res, body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    sseClients,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

const sse = (res: http.ServerResponse, frame: unknown): void => {
  const ev = (frame as { ev?: { type: string } }).ev
  const host = (frame as { host?: { type: string } }).host
  res.write(`event: ${ev?.type ?? host?.type}\ndata: ${JSON.stringify(frame)}\n\n`)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MultiTransport（T4 附着传输）', () => {
  it('信封：send 走 /api/p/{project}/cmd?confirm=true 携带 sessionId+Bearer，回执透传', async () => {
    let seenAuth = ''
    let seenUrl = ''
    let seenBody = ''
    const srv = await startServer((req, res, body) => {
      seenAuth = String(req.headers.authorization)
      seenUrl = req.url ?? ''
      seenBody = body
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: 'pong' }))
    })
    const t = new MultiTransport({ baseUrl: srv.url, token: 'tok-1', project: '/w/proj', getSessionId: () => '2026-08-31T00-00-00-000Z-a' })
    const r = await t.send({ op: 'prompt', text: 'hi', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, value: 'pong' })
    expect(seenAuth).toBe('Bearer tok-1')
    expect(seenUrl).toBe('/api/p/%2Fw%2Fproj/cmd?confirm=true')
    const parsed = JSON.parse(seenBody) as { op: { op: string; text: string }; sessionId: string }
    expect(parsed.op).toMatchObject({ op: 'prompt', text: 'hi' }) // multi 信封：body.op=完整命令对象
    expect(parsed.sessionId).toBe('2026-08-31T00-00-00-000Z-a')
    t.dispose()
    await srv.close()
  })

  it('帧分发：只收当前会话 ev；seq 跟踪；host 帧丢弃', async () => {
    const srv = await startServer(() => {})
    const t = new MultiTransport({
      baseUrl: srv.url,
      token: 't',
      project: '/w/proj',
      getSessionId: () => 'sid-a',
    })
    const seen: Array<{ type: string; seq?: number }> = []
    t.subscribe((ev) => seen.push(ev as { type: string; seq?: number }))
    await vi.waitFor(() => expect(srv.sseClients.length).toBeGreaterThan(0))
    const sseRes = srv.sseClients[0]
    sse(sseRes, { project: '/w/proj', sessionId: 'sid-a', ev: { type: 'delta', seq: 1, text: 'x' } })
    sse(sseRes, { project: '/w/proj', sessionId: 'sid-b', ev: { type: 'delta', seq: 2, text: '他会的' } }) // 他会话过滤
    sse(sseRes, { project: '/w/proj', sessionId: 'sid-a', ev: { type: 'item/completed', seq: 3 } })
    sse(sseRes, { project: '/w/proj', sessionId: 'sid-a', host: { type: 'project/added' } } as never) // host 帧丢弃
    await vi.waitFor(() => expect(seen.map((e) => e.type)).toEqual(['delta', 'item/completed']))
    expect(seen[0]?.seq).toBe(1)
    t.dispose()
    await srv.close()
  })

  it('重连：SSE 断线后退避重连+401 停泵', async () => {
    // 不用 startServer——它的外层包装会先拦 events.mux，这里需要自定义 401/计数行为
    let sseReqCount = 0
    let failAuth = false
    const sseClients: http.ServerResponse[] = []
    const server = http.createServer((req, res) => {
      if (req.url?.includes('/api/events.mux')) {
        sseReqCount++
        if (failAuth) {
          res.writeHead(401)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(':open\n\n')
        sseClients.push(res)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const onReconnect = vi.fn()
    const onUnauthorized = vi.fn()
    const t = new MultiTransport({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      token: 'tok-ok',
      project: '/w/proj',
      getSessionId: () => 'sid-a',
      onReconnect,
      onUnauthorized,
    })
    t.subscribe(() => {})
    await vi.waitFor(() => expect(sseReqCount).toBe(1))
    // —— W-9：断线→重连带 sinceSeq 游标（P1-2 修复回归锁）——
    sseClients[0].destroy()
    await vi.waitFor(() => expect(sseReqCount).toBeGreaterThanOrEqual(2), { timeout: 15000 })
    expect(onReconnect).toHaveBeenCalled()
    // —— 401：停泵不再重连 + onUnauthorized 恰一次（前次断言名不符实，本轮补真 401 覆盖）——
    failAuth = true
    sseClients[sseClients.length - 1].destroy()
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1), { timeout: 15000 })
    const countAtFail = sseReqCount
    await new Promise((r) => setTimeout(r, 2000))
    expect(sseReqCount).toBe(countAtFail) // 停泵：不再重连
    t.dispose()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('W-9：gap=true（重放覆盖不到）触发 onReconnect(true) 全量补拉信号', async () => {
    const sseClients: http.ServerResponse[] = []
    const server = http.createServer((req, res) => {
      if (req.url?.includes('/api/events.mux')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(':open\n\n')
        sseClients.push(res)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const onReconnect = vi.fn()
    const t = new MultiTransport({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      token: 't',
      project: '/w/proj',
      getSessionId: () => 'sid-a',
      onReconnect,
    })
    const seen: Array<{ type: string; seq?: number }> = []
    t.subscribe((ev) => seen.push(ev as { type: string; seq?: number }))
    await vi.waitFor(() => expect(sseClients.length).toBeGreaterThan(0))
    // 模拟 mux 重连基线：gap=true 的 subscribed 帧（缓冲覆盖不到→客户端应触发全量补拉信号）
    const sseRes = sseClients[0]
    const sse = (o: unknown) => sseRes.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`)
    sse({ project: '/w', sessionId: 'sid-a', ev: { type: 'session/subscribed', seq: 9, sessionId: 'sid-a', lastSeq: 9, gap: true } })
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledWith(true))
    // 非 gap 的 subscribed 不触发
    onReconnect.mockClear()
    sse({ project: '/w', sessionId: 'sid-a', ev: { type: 'session/subscribed', seq: 10, sessionId: 'sid-a', lastSeq: 10, gap: false } })
    await new Promise((r) => setTimeout(r, 120))
    expect(onReconnect).not.toHaveBeenCalled()
    t.dispose()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('坏帧跳过：非 JSON data 行不中断流', async () => {
    const sseClients: http.ServerResponse[] = []
    const server = http.createServer((req, res) => {
      if (req.url?.includes('/api/events.mux')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(':open\n\n')
        sseClients.push(res)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const t = new MultiTransport({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 't', project: '/w', getSessionId: () => 's1' })
    const seen: Array<{ type: string }> = []
    t.subscribe((ev) => seen.push(ev as { type: string }))
    await vi.waitFor(() => expect(sseClients.length).toBeGreaterThan(0))
    const sseRes = sseClients[0]
    sseRes.write(`event: delta\n\ndata: {broken json\n\n`)
    sseRes.write(`event: delta\n\ndata: ${JSON.stringify({ project: '/w', sessionId: 's1', ev: { type: 'delta', seq: 1, text: 'x' } })}\n\n`)
    await vi.waitFor(() => expect(seen.map((e) => e.type)).toEqual(['delta']))
    t.dispose()
    await new Promise<void>((r) => server.close(() => r()))
  })
})
