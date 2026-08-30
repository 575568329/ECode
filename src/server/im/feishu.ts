/**
 * M13-W8 飞书 IM gateway（方案 §4A）——第三种客户端形态，接 mux 协议（与 Web 同构）。
 *
 * 通道能力（官方 SDK，长连接模式——免公网 IP/域名/回调 URL，公司电脑零暴露）：
 * - WSClient：企业自建应用 WebSocket 长连接收事件（im.message.receive_v1 消息）与
 *   卡片回调（card.action.trigger——审批三键的回传）。
 * - Client：发消息 API（markdown 富文本）+ 卡片 interactive 消息。
 *
 * 会话映射（Q14 单聊先行）：单聊 bot ↔ ECode 会话一对一。命令：
 *   /new          新建对话（换绑当前用户 → 新 sessionId）
 *   /switch <n>   切到本项目第 n 个历史会话（session/list 序）
 *   /sessions     列出本项目会话
 * 默认：绑定项目最近活跃会话（没有则首条消息隐式新建）。
 *
 * 3s 时限：飞书事件回调 3 秒内需返回——收到消息先回执「处理中」，轮末推完整回复（异步）。
 * 审批转卡片：approval/requested 帧 → interactive 卡片三键（允许/本会话始终允许/拒绝；
 * sensitive 不给始终键——D6 延续）；按钮回调 → mux approval/respond；resolved 后卡片更新为终态。
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { Logger } from '../../services/logger.js'

export interface FeishuGatewayDeps {
  appId: string
  appSecret: string
  logger: Logger
  /** mux 命令面（serve 侧注入——信封路由同 Web） */
  sendCommand: (sessionId: string | undefined, op: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; sessionId?: string; value?: unknown }>
  /** mux 订阅面（审批帧等） */
  subscribe: (handler: (frame: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }) => void) => () => void
  /** 项目根（默认绑定的项目） */
  project: string
  /** 历史会话列表（/sessions /switch 用——session/list 冷热合并） */
  listSessions: () => Promise<Array<{ sessionId: string; firstUser: string; running?: boolean }>>
  /** 发送者白名单（open_id 列表；缺省=拒绝所有——p2p bot 整租户可见，无白名单=开放执行端点，审阅 P0-1） */
  allowUsers?: string[]
  dispose?: () => void
}

/** 单聊用户 → 绑定会话（实例字段——曾为模块级，多 gateway 实例串台 + 测试间污染） */

export class FeishuGateway {
  private readonly client: lark.Client
  private ws?: lark.WSClient
  private unsub?: () => void
  /** requestId → 卡片与审批归属会话（respond 回填 sessionId——曾丢落默认会话 broker，
   *  非默认会话审批必然 not-pending 超时，审阅 P1-1） */
  private readonly pendingCards = new Map<string, { chatId: string; messageId: string; sessionId?: string }>()
  private readonly binding = new Map<string, string>()
  private disposed = false

  constructor(private readonly deps: FeishuGatewayDeps) {
    this.client = new lark.Client({ appId: deps.appId, appSecret: deps.appSecret })
  }

  /** 白名单守卫（缺省拒绝；空串 openId 一并拒） */
  private allowed(openId: string): boolean {
    const list = this.deps.allowUsers
    if (list === undefined || list.length === 0) return false
    return openId !== '' && list.includes(openId)
  }

  async start(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.onMessage(data)
        } catch (e) {
          this.deps.logger.warn('im', 'feishu_message_failed', { message: e instanceof Error ? e.message : String(e) })
        }
        // 3s 内返回（异步处理在 onMessage 内部 fire-and-forget）
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.onCardAction(data)
        } catch (e) {
          this.deps.logger.warn('im', 'feishu_card_failed', { message: e instanceof Error ? e.message : String(e) })
        }
        return { toast: { type: 'success', content: '已处理' } }
      },
    })
    // 诊断（G-IM 真机门排查）：WS 状态转移落日志——serve 形态事件零到达，需观察连接是否被踢/重连
    this.ws = new lark.WSClient({
      appId: this.deps.appId,
      appSecret: this.deps.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      onReconnecting: () => this.deps.logger.warn('im', 'feishu_ws_reconnecting', {}),
      onReconnected: () => this.deps.logger.warn('im', 'feishu_ws_reconnected', {}),
      onError: (e: unknown) => this.deps.logger.warn('im', 'feishu_ws_error', { message: e instanceof Error ? e.message : String(e) }),
    })
    await this.ws.start({ eventDispatcher: dispatcher })
    // mux 订阅：审批帧 → 卡片；轮末 → 推送回复
    this.unsub = this.deps.subscribe((frame) => void this.onFrame(frame))
    this.deps.logger.info('im', 'feishu_started', { project: this.deps.project })
  }

  dispose(): void {
    this.disposed = true
    this.unsub?.()
    // WSClient 关闭曾漏（dispose 只退订 mux）——gateway 单独重启用例连接不受管（审阅 P2-6）
    try {
      this.ws?.close()
    } catch {
      /* SDK close 幂等 */
    }
    this.deps.dispose?.()
  }

  // —— 消息入（单聊驱动会话） ——
  private async onMessage(data: unknown): Promise<void> {
    // WSClient 长连接事件是扁平结构（message/sender 在顶层——真机 G-IM 实证）；
    // webhook 回调形态才是 { event: { message, sender } } 包裹。两种都兼容。
    const d = data as {
      message?: { chat_id?: string; chat_type?: string; message_type?: string; content?: string }
      sender?: { sender_id?: { open_id?: string } }
      event?: { message?: { chat_id?: string; chat_type?: string; message_type?: string; content?: string }; sender?: { sender_id?: { open_id?: string } } }
    }
    const msg = d.message ?? d.event?.message
    const sender = d.sender ?? d.event?.sender
    const chatType = msg?.chat_type
    const openId = sender?.sender_id?.open_id ?? ''
    if (chatType !== 'p2p' || msg?.message_type !== 'text') return // 群聊/富文本忽略（Q14 单聊先行）
    if (!this.allowed(openId)) {
      // 非白名单静默忽略（不回执——不向陌生者暴露 bot 存活面）
      this.deps.logger.warn('im', 'feishu_denied', { openId })
      return
    }
    let text = ''
    try {
      text = String(JSON.parse(msg.content ?? '{}').text ?? '')
    } catch {
      return
    }
    if (text.trim() === '') return
    const chatId = msg.chat_id ?? ''
    this.rememberChat(openId, chatId)
    this.deps.logger.info('im', 'feishu_message', { openId, len: text.length })

    // 命令面
    if (text.startsWith('/new')) {
      // 真新建并换绑（曾只删绑定——下一条消息隐式路由复用旧默认会话，审阅 P1-3）
      const r = await this.deps.sendCommand(undefined, { op: 'session/new' })
      const sid = r.sessionId ?? ''
      if (r.ok && sid !== '') {
        this.binding.set(openId, sid)
        await this.replyText(chatId, `已新建对话（${sid.slice(-8)}）——直接发言即可。`)
      } else {
        await this.replyText(chatId, `新建失败：${r.error ?? '未知'}`)
      }
      return
    }
    if (text.startsWith('/sessions')) {
      const list = await this.deps.listSessions()
      const lines = list.slice(0, 10).map((s, i) => `${i + 1}. ${(s.firstUser ?? '').slice(0, 30)}${s.running === true ? ' ●运行中' : ''}`)
      await this.replyText(chatId, lines.length > 0 ? `本项目会话：\n${lines.join('\n')}\n（/switch <序号> 切换）` : '暂无历史会话。')
      return
    }
    if (text.startsWith('/switch')) {
      const n = Number(text.split(/\s+/)[1] ?? '0')
      const list = await this.deps.listSessions()
      const target = list[n - 1]
      if (target === undefined) {
        await this.replyText(chatId, `序号无效（1-${Math.min(list.length, 10)}）。`)
        return
      }
      this.binding.set(openId, target.sessionId)
      await this.replyText(chatId, `已切换到：${(target.firstUser ?? '').slice(0, 30)}`)
      return
    }

    // 会话驱动：绑定或隐式新建（三态③——sendCommand 不带 sessionId）
    const bound = this.binding.get(openId)
    await this.replyText(chatId, '收到，处理中…') // 3s 回执
    const r = await this.deps.sendCommand(bound, { op: 'prompt', text, mode: 'StartOrSteer' })
    if (r.ok && r.sessionId !== undefined && r.sessionId !== '') this.binding.set(openId, r.sessionId)
    if (!r.ok) await this.replyText(chatId, `执行失败：${r.error ?? '未知'}`)
  }

  // —— mux 帧出（轮末推送 + 审批卡片） ——
  private async onFrame(frame: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }): Promise<void> {
    if (this.disposed || frame.project !== this.deps.project) return
    // 找绑定了该会话的用户（O(n) 单聊规模可接受）
    let openId: string | null = null
    for (const [k, v] of this.binding) if (v === frame.sessionId) openId = k
    if (openId === null) return
    const chatId = this.chatIdOf(openId)
    if (chatId === null) return

    if (frame.ev.type === 'turn/completed') {
      // 轮末推送：从宿主侧拿不到完整回复文本（W8 简化——用 item/completed+delta 聚合在 gateway 不现实；
      // 走 session/read 尾页取最后 assistant 文本）
      const r = await this.deps.sendCommand(frame.sessionId, { op: 'session/read', sessionId: frame.sessionId })
      if (r.ok && Array.isArray(r.value)) {
        const lines = r.value as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>
        const lastAssistant = [...lines].reverse().find((l) => l.role === 'assistant')
        const text = (lastAssistant?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        if (text !== '') await this.replyMarkdown(chatId, text.slice(0, 3500))
      }
      return
    }
    if (frame.ev.type === 'approval/requested') {
      const requestId = String(frame.ev.requestId ?? '')
      const sensitive = String(frame.ev.kind ?? '') === 'sensitive'
      const tool = String(frame.ev.tool ?? '')
      const preview = String(frame.ev.preview ?? '').slice(0, 600)
      const buttons: Array<{ tag: string; text: { tag: string; content: string }; type?: string; value?: string }> = []
      if (!sensitive && Array.isArray(frame.ev.decisions) && (frame.ev.decisions as string[]).includes('always')) {
        buttons.push({ tag: 'button', text: { tag: 'plain_text', content: '本会话始终允许' }, type: 'primary', value: JSON.stringify({ requestId, decision: 'always' }) })
      }
      buttons.push(
        { tag: 'button', text: { tag: 'plain_text', content: '允许' }, type: 'primary', value: JSON.stringify({ requestId, decision: 'once' }) },
        { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: JSON.stringify({ requestId, decision: 'reject' }) },
      )
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: sensitive ? '⚠ 敏感操作确认（不可记住）' : '需要审批' }, template: 'orange' },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${tool}\`` } },
          // 审阅 P1-4：preview 内嵌 ``` 会提前闭合围栏，后续内容按 lark_md 渲染（粗体/链接）——
          // 审批闸上的视觉伪装可诱导点"允许"。preview 源头（bash 命令/diff/MCP JSON）全可被
          // 恶意仓库影响，入卡前剥围栏序列（换零宽不占格的替代——内容保真、渲染形态破碎化）
          { tag: 'div', text: { tag: 'lark_md', content: `\`\`\`${preview.replace(/```/g, '｀｀｀')}\`\`\`` } },
          { tag: 'action', actions: buttons },
        ],
      }
      const sent = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      })
      if (sent.data?.message_id !== undefined) this.pendingCards.set(requestId, { chatId, messageId: sent.data.message_id, sessionId: frame.sessionId })
      return
    }
    if (frame.ev.type === 'approval/resolved') {
      // 卡片置终态（更新为纯文本结果卡）
      const requestId = String(frame.ev.requestId ?? '')
      const card = this.pendingCards.get(requestId)
      if (card !== undefined) {
        this.pendingCards.delete(requestId)
        const outcome = String(frame.ev.outcome ?? '')
        const zh = outcome === 'once' || outcome === 'always' ? `已${outcome === 'always' ? '始终' : ''}允许` : outcome === 'reject' ? '已拒绝' : outcome === 'timeout' ? '已超时自动拒绝' : outcome
        void this.client.im.message
          .patch({ path: { message_id: card.messageId }, data: { content: JSON.stringify({ config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: `审批${zh}` }, template: outcome === 'reject' || outcome === 'timeout' ? 'red' : 'green' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: `终态：${zh}` } }] }) } })
          .catch(() => {})
      }
    }
  }

  // —— 卡片按钮回调 → approval/respond ——
  private async onCardAction(data: unknown): Promise<void> {
    // 同 onMessage：长连接事件扁平结构（action/operator 在顶层），webhook 形态才有 event 包裹
    const d = data as { action?: { value?: string }; operator?: { open_id?: string }; event?: { action?: { value?: string }; operator?: { open_id?: string } } }
    const raw = d.action?.value ?? d.event?.action?.value
    if (typeof raw !== 'string') return
    // 操作者同走白名单（审批卡可能被转发到别的会话/由他人点按——审阅 P0-1 卡片侧）
    const operator = d.operator?.open_id ?? d.event?.operator?.open_id ?? ''
    if (!this.allowed(operator)) {
      this.deps.logger.warn('im', 'feishu_card_denied', { openId: operator })
      return
    }
    try {
      const { requestId, decision } = JSON.parse(raw) as { requestId: string; decision: string }
      // sessionId 从卡片登记回填（挂起帧携带的归属会话——undefined 曾落默认会话 broker 必 not-pending）
      const card = this.pendingCards.get(requestId)
      await this.deps.sendCommand(card?.sessionId, { op: 'approval/respond', requestId, decision })
    } catch {
      /* 无效载荷忽略 */
    }
  }

  // —— 发送助手 ——
  private chatCache = new Map<string, string>()
  private chatIdOf(openId: string): string | null {
    return this.chatCache.get(openId) ?? null
  }
  /** 首条消息时记录 openId→chatId 映射（onMessage 里 chatId 现成——缓存供 onFrame 反查） */
  private rememberChat(openId: string, chatId: string): void {
    this.chatCache.set(openId, chatId)
  }

  private async replyText(chatId: string, text: string): Promise<void> {
    if (chatId === '') return
    void this.client.im.message
      .create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) } })
      .catch((e: unknown) => this.deps.logger.warn('im', 'feishu_reply_failed', { message: e instanceof Error ? e.message : String(e) }))
  }

  private async replyMarkdown(chatId: string, text: string): Promise<void> {
    if (chatId === '') return
    // M14-C5③：post 富文本（此前名不副实发纯 text——LLM 回复的 markdown 全成裸符号）
    void this.client.im.message
      .create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: markdownToPost(text) } }) },
      })
      .catch((e: unknown) => this.deps.logger.warn('im', 'feishu_reply_failed', { message: e instanceof Error ? e.message : String(e) }))
  }
}

/** post 富文本行内元素（飞书 im/v1 content.post.zh_cn.content 二维数组的叶子） */
interface PostElement {
  tag: string
  text?: string
  href?: string
  /** 飞书 post 无独立 bold/code tag——样式走 text 元素的 style 数组（官方 create_json 文档） */
  style?: string[]
}

/**
 * M14-C5③：markdown → 飞书 post 结构（务实最小解析，非全量 AST）。
 * 块级：```围栏代码块``` → 逐行 code 元素（post 无真正块代码）；# 标题 → bold 行；
 * -/* 列表行加 "•"；空行分段。行内：**bold**、`code`、[text](url)。
 * 未知语法保持原文本（飞书 text 元素按字面渲染，零丢失）。
 */
export function markdownToPost(text: string): PostElement[][] {
  const out: PostElement[][] = []
  const lines = text.split('\n')
  let codeBuf: string[] | null = null
  const flushCode = (): void => {
    if (codeBuf === null) return
    // post 无 code tag（400 实证）——代码行降级 text；缩进保留视觉块感
    for (const l of codeBuf) out.push([{ tag: 'text', text: `  ${l}` }])
    codeBuf = null
  }
  for (const raw of lines) {
    const fence = /^```(\w*)\s*$/.exec(raw.trim())
    if (fence !== null) {
      if (codeBuf !== null) flushCode()
      else {
        codeBuf = []
      }
      continue
    }
    if (codeBuf !== null) {
      codeBuf.push(raw)
      continue
    }
    const t = raw.trim()
    if (t === '') {
      out.push([{ tag: 'text', text: ' ' }]) // 空段落用单空格 text 占位（裸 [] 400 风险）
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t)
    if (heading !== null) {
      out.push([{ tag: 'text', text: heading[2], style: ['bold'] }])
      continue
    }
    const li = /^[-*]\s+(.*)$/.exec(t)
    if (li !== null) {
      out.push([{ tag: 'text', text: '• ' }, ...inlineRuns(li[1])])
      continue
    }
    out.push(inlineRuns(t))
  }
  flushCode() // 未闭合围栏兜底
  return out
}

/** 行内三模式 tokenizer：**bold** / `code` / [text](url)；段间原样 text */
function inlineRuns(line: string): PostElement[] {
  const runs: PostElement[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m.index > last) runs.push({ tag: 'text', text: line.slice(last, m.index) })
    if (m[1] !== undefined) runs.push({ tag: 'text', text: m[1], style: ['bold'] })
    else if (m[2] !== undefined) runs.push({ tag: 'text', text: m[2] }) // post 无行内 code——降级 text
    else if (m[3] !== undefined && m[4] !== undefined) runs.push({ tag: 'a', text: m[3], href: m[4] })
    last = m.index + m[0].length
  }
  if (last < line.length) runs.push({ tag: 'text', text: line.slice(last) })
  return runs.length > 0 ? runs : [{ tag: 'text', text: '' }]
}
