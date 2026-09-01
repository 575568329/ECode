/**
 * R4 审阅修复回归：/switch 换绑 + 短码兑换者绑定（T7——白名单内他人不得应答）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WechatGateway } from '../../src/server/im/wechat.js'
import type { Logger } from '../../src/services/logger.js'

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger
const USER_A = 'wxid-a@im.wechat'
const USER_B = 'wxid-b@im.wechat'

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('微信 gateway 审阅加固', () => {
  let api: { port: number; sent: Array<Record<string, unknown>>; pushInbound: (m: Record<string, unknown>) => void; close: () => Promise<void> }
  const cleanup: Array<WechatGateway> = []

  beforeEach(async () => {
    const inbound: Array<Record<string, unknown>> = []
    const sent: Array<Record<string, unknown>> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url === '/ilink/bot/getupdates') {
          const msg = inbound.shift()
          res.end(JSON.stringify({ ret: 0, msgs: msg !== undefined ? [msg] : [], get_updates_buf: `c-${Date.now()}` }))
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
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    api = { port, sent, pushInbound: (m) => inbound.push(m), close: () => new Promise((d) => server.close(() => d())) }
  })
  afterEach(async () => {
    for (const g of cleanup.splice(0)) g.dispose()
    await api.close()
  })

  function make(): { gw: WechatGateway; commands: Array<{ sessionId: string | undefined; op: Record<string, unknown> }>; emitFrame: (f: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }) => void } {
    const commands: Array<{ sessionId: string | undefined; op: Record<string, unknown> }> = []
    let handler: ((f: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }) => void) | null = null
    const gw = new WechatGateway({
      botToken: 't',
      allowUsers: [USER_A, USER_B],
      logger,
      apiBase: `http://127.0.0.1:${api.port}`,
      project: '/w/proj',
      sendCommand: async (sessionId, op) => {
        commands.push({ sessionId, op })
        if ((op as { op?: string }).op === 'session/read') return { ok: true, value: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }
        if ((op as { op?: string }).op === 'prompt') return { ok: true, sessionId: 'sid-1' } // 绑定建立（onFrame 路由依赖）
        return { ok: true }
      },
      subscribe: (h) => {
        handler = h
        return () => {}
      },
      listSessions: async () => [
        { sessionId: 'sid-1', firstUser: '第一个' },
        { sessionId: 'sid-2', firstUser: '第二个' },
      ],
    })
    cleanup.push(gw)
    return { gw, commands, emitFrame: (f) => handler?.(f) }
  }

  const sentTexts = (): string[] =>
    api.sent.map((m) => (m as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg?.item_list?.[0]?.text_item?.text ?? '')

  it('/switch 2 换绑到目标会话并回执', async () => {
    const { gw, commands } = make()
    await gw.start()
    api.pushInbound({ from_user_id: USER_A, message_type: 1, message_state: 2, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '/switch 2' } }] })
    await waitFor(() => commands.some((c) => (c.op as { op?: string }).op === 'session/read') || sentTexts().some((t) => t.includes('已切换到')))
    await waitFor(() => sentTexts().some((t) => t.includes('已切换到：第二个')))
    expect(sentTexts().some((t) => t.includes('已切换到：第二个'))).toBe(true)
  })

  it('短码兑换者绑定：白名单内他人回码被拒且不产生 approval/respond（T7）', async () => {
    const { gw, commands, emitFrame } = make()
    await gw.start()
    // A 先建立 context 并触发审批出码
    api.pushInbound({ from_user_id: USER_A, message_type: 1, message_state: 2, context_token: 'ctx-a', item_list: [{ type: 1, text_item: { text: '开始' } }] })
    await waitFor(() => commands.some((c) => (c.op as { op?: string }).op === 'prompt'))
    emitFrame({ project: '/w/proj', sessionId: 'sid-1', ev: { type: 'approval/requested', requestId: 'req-x', kind: 'command', tool: 'bash', preview: 'ls' } })
    await waitFor(() => sentTexts().some((t) => /回复「\d{4} y」/.test(t)))
    const code = /回复「(\d{4}) y」/.exec(sentTexts().find((t) => /回复「\d{4} y」/.test(t)) ?? '')?.[1] ?? ''
    expect(code).not.toBe('')
    // B（白名单内他人）拿码应答 → 拒（短码无效），且不产生 approval/respond
    api.pushInbound({ from_user_id: USER_B, message_type: 1, message_state: 2, context_token: 'ctx-b', item_list: [{ type: 1, text_item: { text: `${code} y` } }] })
    await waitFor(() => sentTexts().some((t) => t === '短码无效。'))
    expect(commands.some((c) => (c.op as { op?: string }).op === 'approval/respond')).toBe(false)
    // A 本人应答 → 放行
    api.pushInbound({ from_user_id: USER_A, message_type: 1, message_state: 2, context_token: 'ctx-a2', item_list: [{ type: 1, text_item: { text: `${code} y` } }] })
    await waitFor(() => commands.some((c) => (c.op as { op?: string }).op === 'approval/respond'))
    const respond = commands.find((c) => (c.op as { op?: string }).op === 'approval/respond')
    expect((respond!.op as { requestId?: string }).requestId).toBe('req-x')
  })
})
