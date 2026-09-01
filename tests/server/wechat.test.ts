/**
 * R4 微信 ClawBot gateway 测试：mock iLink HTTP 服务器（getupdates 长轮询/sendmessage 捕获）
 * + fake mux 注入面。覆盖：白名单缺省拒（T6）/命令与 prompt 驱动/context_token 回带/
 * 审批短码全流程（T7：requested→出码→数字回复→approval/respond）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WechatGateway } from '../../src/server/im/wechat.js'
import type { Logger } from '../../src/services/logger.js'

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

const USER = 'wxid-friend@im.wechat'
const STRANGER = 'wxid-stranger@im.wechat'

/** mock iLink：脚本化的入站消息队列 + sendmessage 捕获 */
function mockIlink(): Promise<{
  port: number
  sent: Array<Record<string, unknown>>
  pushInbound: (msg: Record<string, unknown>) => void
  close: () => Promise<void>
}> {
  return new Promise((resolve) => {
    const inbound: Array<Record<string, unknown>> = []
    const sent: Array<Record<string, unknown>> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url === '/ilink/bot/getupdates') {
          const msg = inbound.shift()
          res.end(
            JSON.stringify({
              ret: 0,
              msgs: msg !== undefined ? [msg] : [],
              get_updates_buf: `cursor-${Date.now()}`,
            }),
          )
          return
        }
        if (req.url === '/ilink/bot/sendmessage') {
          sent.push(JSON.parse(body) as Record<string, unknown>)
          res.end(JSON.stringify({ ret: 0 }))
          return
        }
        res.end(JSON.stringify({ ret: 0 }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        sent,
        pushInbound: (msg) => inbound.push(msg),
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function makeGateway(apiPort: number, opts: { allowUsers?: string[] } = {}): {
  gw: WechatGateway
  commands: Array<{ sessionId: string | undefined; op: Record<string, unknown> }>
  emitFrame: (frame: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }) => void
} {
  const commands: Array<{ sessionId: string | undefined; op: Record<string, unknown> }> = []
  let handler: ((frame: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }) => void) | null = null
  const gw = new WechatGateway({
    botToken: 'test-bot-token',
    allowUsers: opts.allowUsers,
    logger,
    apiBase: `http://127.0.0.1:${apiPort}`,
    project: '/w/proj',
    sendCommand: async (sessionId, op) => {
      commands.push({ sessionId, op })
      if ((op as { op?: string }).op === 'session/new') return { ok: true, sessionId: 'sid-new-1' }
      if ((op as { op?: string }).op === 'prompt') return { ok: true, sessionId: 'sid-conv-1' }
      if ((op as { op?: string }).op === 'session/read') return { ok: true, value: [{ role: 'assistant', content: [{ type: 'text', text: '回复正文' }] }] }
      return { ok: true }
    },
    subscribe: (h) => {
      handler = h
      return () => {}
    },
    listSessions: async () => [{ sessionId: 'sid-1', firstUser: '第一句话', running: false }],
  })
  return { gw, commands, emitFrame: (f) => handler?.(f) }
}

function inboundText(from: string, text: string): Record<string, unknown> {
  return {
    from_user_id: from,
    message_type: 1,
    message_state: 2,
    context_token: `ctx-${Math.random().toString(36).slice(2, 8)}`,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

/** 轮询等待（竞态免疫——mock 长轮询即时返回，固定 sleep 会撞在途请求） */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('微信 ClawBot gateway', () => {
  let api: Awaited<ReturnType<typeof mockIlink>>
  const cleanup: Array<WechatGateway> = []

  beforeEach(async () => {
    api = await mockIlink() // 每测独立 mock——共享队列会被 dispose 后仍在途的旧 pollLoop 抢消息
  })
  afterEach(async () => {
    for (const g of cleanup.splice(0)) g.dispose()
    await api.close()
  })

  it('白名单缺省拒：陌生者消息零回执零命令（T6）', async () => {
    const { gw, commands } = makeGateway(api.port) // 不给 allowUsers
    await gw.start()
    api.pushInbound(inboundText(STRANGER, '你好'))
    await new Promise((r) => setTimeout(r, 300))
    await new Promise((r) => setTimeout(r, 300))
    expect(commands).toHaveLength(0)
    expect(api.sent).toHaveLength(0)
  })

  it('白名单用户驱动会话：prompt 命令 + context_token 回带 + 轮末推送', async () => {
    const { gw, commands, emitFrame } = makeGateway(api.port, { allowUsers: [USER] })
    await gw.start()
    api.pushInbound(inboundText(USER, '帮我看看构建'))
    await waitFor(() => commands.some((c) => (c.op as { op?: string }).op === 'prompt'))
    expect((commands.find((c) => (c.op as { op?: string }).op === 'prompt')!.op as { text?: string }).text).toBe('帮我看看构建')
    // turn/completed → session/read 尾页 → 被动回复（context_token 原样回带）
    emitFrame({ project: '/w/proj', sessionId: 'sid-conv-1', ev: { type: 'turn/completed' } })
    await waitFor(() => api.sent.some((m) => ((m as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg?.item_list ?? [])[0]?.text_item?.text === '回复正文'))
    const reply = api.sent.find((m) => ((m as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg?.item_list ?? [])[0]?.text_item?.text === '回复正文')
    expect(((reply as { msg?: { context_token?: string } }).msg?.context_token ?? '').startsWith('ctx-')).toBe(true)
  })

  it('审批短码全流程：requested 出码 → 数字回复 → approval/respond（T7）', async () => {
    const { gw, commands, emitFrame } = makeGateway(api.port, { allowUsers: [USER] })
    await gw.start()
    // 先建立 context（被动通道——有入站才有出站）
    api.pushInbound(inboundText(USER, '开始'))
    await waitFor(() => commands.some((c) => (c.op as { op?: string }).op === 'prompt'))
    // 审批帧 → 出站文本含 4 位短码与 preview 指纹
    emitFrame({ project: '/w/proj', sessionId: 'sid-conv-1', ev: { type: 'approval/requested', requestId: 'req-1', kind: 'command', tool: 'bash', preview: 'npm run build' } })
    await waitFor(() => api.sent.some((m) => (m as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg?.item_list?.[0]?.text_item?.text?.includes('需要审批') === true))
    const approvalMsg = api.sent.map((m) => (m as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg).find((m) => m?.item_list?.[0]?.text_item?.text?.includes('需要审批'))
    expect(approvalMsg).toBeDefined()
    const codeMatch = /回复「(\d{4}) y」/.exec(approvalMsg!.item_list![0].text_item!.text ?? '')
    expect(codeMatch).not.toBeNull()
    // 数字回复 → approval/respond once
    api.pushInbound(inboundText(USER, `${codeMatch![1]} y`))
    await new Promise((r) => setTimeout(r, 400))
    const respond = commands.find((c) => (c.op as { op?: string }).op === 'approval/respond')
    expect(respond).toBeDefined()
    expect((respond!.op as { requestId?: string; decision?: string }).requestId).toBe('req-1')
    expect((respond!.op as { decision?: string }).decision).toBe('once')
  })

  it('/new 命令：真新建并换绑', async () => {
    const { gw, commands } = makeGateway(api.port, { allowUsers: [USER] })
    await gw.start()
    api.pushInbound(inboundText(USER, '/new'))
    await waitFor(() => commands.some((c) => (c.op as { op?: string }).op === 'session/new'))
    const newCmd = commands.find((c) => (c.op as { op?: string }).op === 'session/new')
    expect(newCmd).toBeDefined()
    await waitFor(() => api.sent.some((m) => (m as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg?.item_list?.[0]?.text_item?.text?.includes('已新建对话') === true))
  })
})
