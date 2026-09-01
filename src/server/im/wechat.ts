/**
 * R4：微信 ClawBot gateway（iLink 协议——首个官方合法的微信 Bot API，2026-03 开放）。
 *
 * 通道能力（HTTP/JSON 直连 ilinkai.weixin.qq.com，零 SDK）：
 * - 收消息：POST /ilink/bot/getupdates 长轮询（服务器 hold ≤35s；游标 get_updates_buf 必须回传，
 *   否则重复收——Telegram getUpdates 同构）；
 * - 发消息：POST /ilink/bot/sendmessage（被动形态——必须原样回带入站消息的 context_token）；
 * - 登录：二维码流程见 `ecode wechat-login`（bot_token 持久化后配置进 config.wechat.botToken）。
 *
 * 三限制内建（M14 方案 §8）：被动回复（定位「用户发起式」轻交互面——命令/插话/审批；无主动
 * 通知）；context_token 时效（发送失败记 warn，过期即本轮静默）；纯文本（审批三键退化为
 * 数字短码回复——T7：短码+preview 指纹绑定，随审批终结作废）。
 *
 * 安全（T6）：sender 白名单（allowUsers，user id 形如 xxx@im.wechat）缺省拒——对齐 feishu
 * allowUsers 语义（M13 审阅 P0-1 前车：p2p bot 整租户可见，无白名单=开放执行端点）。
 */

import { randomInt } from 'node:crypto'
import type { Logger } from '../../services/logger.js'

export const ILINK_API_BASE = 'https://ilinkai.weixin.qq.com'
const POLL_HOLD_MS = 35_000
const ERROR_BACKOFF_MS = 3_000
/** 审批短码有效期（对齐宿主 approvalTimeoutMs D-T8 拍板缺省 1h——随 mux resolved 帧即时作废） */
const APPROVAL_CODE_TTL_MS = 60 * 60_000

export interface WechatGatewayDeps {
  botToken: string
  logger: Logger
  /** sender 白名单（user id 列表；缺省/空=拒绝所有） */
  allowUsers?: string[]
  /** mux 命令面（serve 侧注入——信封路由同 Web/飞书） */
  sendCommand: (sessionId: string | undefined, op: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; sessionId?: string; value?: unknown }>
  /** mux 订阅面（审批帧/轮末帧） */
  subscribe: (handler: (frame: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }) => void) => () => void
  /** 项目根（默认绑定项目） */
  project: string
  /** 历史会话列表（/sessions /switch） */
  listSessions: () => Promise<Array<{ sessionId: string; firstUser: string; running?: boolean }>>
  /** iLink API 基址（测试注入 mock；生产缺省官方域名） */
  apiBase?: string
  dispose?: () => void
}

interface InboundMsg {
  from_user_id?: string
  message_type?: number
  message_state?: number
  context_token?: string
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>
}

export class WechatGateway {
  private readonly api: string
  private cursor = ''
  private disposed = false
  private readonly binding = new Map<string, string>()
  /** user id → 最近入站 context_token（被动回复的通道约束） */
  private readonly contexts = new Map<string, { token: string; at: number }>()
  /** 审批短码 → 目标（T7：数字回复必须带短码；随 mux resolved 即时作废） */
  private readonly approvalCodes = new Map<string, { requestId: string; sessionId: string; userId: string; expiresAt: number }>()
  private readonly unsub?: () => void

  constructor(private readonly deps: WechatGatewayDeps) {
    this.api = (deps.apiBase ?? ILINK_API_BASE).replace(/\/$/, '')
    this.unsub = deps.subscribe((frame) => void this.onFrame(frame))
  }

  async start(): Promise<void> {
    this.deps.logger.info('im', 'wechat_started', { project: this.deps.project, base: this.api })
    void this.pollLoop()
  }

  dispose(): void {
    this.disposed = true
    this.unsub?.()
    this.deps.dispose?.()
  }

  /** sender 白名单（缺省拒绝；空串一并拒——feishu 同款） */
  private allowed(userId: string): boolean {
    const list = this.deps.allowUsers
    if (list === undefined || list.length === 0) return false
    return userId !== '' && list.includes(userId)
  }

  // ———————————————— 长轮询收消息 ————————————————
  private async pollLoop(): Promise<void> {
    while (!this.disposed) {
      try {
        const res = await this.callApi('/ilink/bot/getupdates', {
          get_updates_buf: this.cursor,
          base_info: { channel_version: '1.0.2' },
        })
        if (this.disposed) return
        const body = res as { ret?: number; msgs?: InboundMsg[]; get_updates_buf?: string; err_msg?: string }
        if (typeof body.ret === 'number' && body.ret !== 0) {
          // iLink 带内错误（HTTP 200 + ret!=0）：当成功会静默空转（审阅 P2）
          throw new Error(`iLink ret=${body.ret}${body.err_msg !== undefined ? ` ${body.err_msg}` : ''}`)
        }
        if (typeof body.get_updates_buf === 'string' && body.get_updates_buf !== '') this.cursor = body.get_updates_buf
        for (const msg of body.msgs ?? []) {
          try {
            await this.onMessage(msg)
          } catch (e) {
            this.deps.logger.warn('im', 'wechat_message_failed', { message: e instanceof Error ? e.message : String(e) })
          }
        }
      } catch (e) {
        if (this.disposed) return
        this.deps.logger.warn('im', 'wechat_poll_failed', { message: e instanceof Error ? e.message : String(e) })
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS))
      }
    }
  }

  private async onMessage(msg: InboundMsg): Promise<void> {
    const userId = String(msg.from_user_id ?? '')
    if (msg.message_type !== 1 || msg.message_state !== 2) return // 1=入站、2=FINISH 完整消息
    if (!this.allowed(userId)) {
      // 非白名单静默忽略（不回执——不向陌生者暴露 bot 存活面）
      this.deps.logger.warn('im', 'wechat_denied', { userId })
      return
    }
    const text = (msg.item_list ?? []).filter((i) => i.type === 1).map((i) => i.text_item?.text ?? '').join('').trim()
    if (text === '') return
    const contextToken = String(msg.context_token ?? '')
    if (contextToken !== '') this.contexts.set(userId, { token: contextToken, at: Date.now() })

    // 审批短码回复（T7）：`1234 y` / `1234 n`
    const codeMatch = /^(\d{3,6})\s*(y|yes|n|no|允许|拒绝)$/i.exec(text)
    if (codeMatch !== null) {
      const entry = this.approvalCodes.get(codeMatch[1])
      // T7 兑换者绑定：短码私发给绑定者——白名单内其他用户不得应答（收敛无效回执 oracle 面）
      if (entry !== undefined && entry.userId !== userId) {
        this.deps.logger.warn('im', 'wechat_code_wrong_user', { userId })
        await this.replyText(userId, `短码无效。`)
        return
      }
      if (entry === undefined || entry.expiresAt <= Date.now()) {
        if (entry !== undefined) this.approvalCodes.delete(codeMatch[1])
        await this.replyText(userId, `短码无效或已过期。`)
        return
      }
      const approve = !/^(n|no)/i.test(codeMatch[2]) && codeMatch[2] !== '拒绝'
      const decision = approve ? 'once' : 'reject'
      this.approvalCodes.delete(codeMatch[1])
      const r = await this.deps.sendCommand(entry.sessionId, { op: 'approval/respond', requestId: entry.requestId, decision })
      await this.replyText(userId, r.ok === true ? `已${decision === 'once' ? '允许' : '拒绝'}（${codeMatch[1]}）` : `审批回执失败：${r.error ?? '未知'}`)
      return
    }

    // 命令面（对齐 feishu /new /sessions /switch）
    if (text.startsWith('/new')) {
      const r = await this.deps.sendCommand(undefined, { op: 'session/new' })
      const sid = r.sessionId ?? ''
      if (r.ok && sid !== '') {
        this.binding.set(userId, sid)
        await this.replyText(userId, `已新建对话（${sid.slice(-8)}）——直接发言即可。`)
      } else {
        await this.replyText(userId, `新建失败：${r.error ?? '未知'}`)
      }
      return
    }
    if (text.startsWith('/sessions')) {
      const list = await this.deps.listSessions()
      const lines = list.slice(0, 10).map((s, i) => `${i + 1}. ${(s.firstUser ?? '').slice(0, 30)}${s.running === true ? ' ●运行中' : ''}`)
      await this.replyText(userId, lines.length > 0 ? `本项目会话：\n${lines.join('\n')}\n（/switch <序号> 切换）` : '暂无历史会话。')
      return
    }
    if (text.startsWith('/switch')) {
      const n = Number(text.split(/\s+/)[1] ?? '0')
      const list = await this.deps.listSessions()
      const target = list[n - 1]
      if (target === undefined) {
        await this.replyText(userId, `序号无效（1-${Math.min(list.length, 10)}）。`)
        return
      }
      this.binding.set(userId, target.sessionId)
      await this.replyText(userId, `已切换到：${(target.firstUser ?? '').slice(0, 30)}`)
      return
    }

    // 会话驱动：绑定或隐式新建（三态③）
    const bound = this.binding.get(userId)
    const r = await this.deps.sendCommand(bound, { op: 'prompt', text, mode: 'StartOrSteer' })
    if (r.ok && r.sessionId !== undefined && r.sessionId !== '') this.binding.set(userId, r.sessionId)
    if (!r.ok) await this.replyText(userId, `执行失败：${r.error ?? '未知'}`)
  }

  // ———————————————— mux 帧出 ————————————————
  private async onFrame(frame: { project: string; sessionId: string; ev: { type: string; [k: string]: unknown } }): Promise<void> {
    if (this.disposed || frame.project !== this.deps.project) return
    let userId: string | null = null
    for (const [k, v] of this.binding) if (v === frame.sessionId) userId = k
    if (userId === null) return
    const ctx = this.contexts.get(userId)
    if (ctx === undefined) return // 从未发言——被动通道不可主动首推

    if (frame.ev.type === 'turn/completed') {
      const r = await this.deps.sendCommand(frame.sessionId, { op: 'session/read', sessionId: frame.sessionId })
      if (r.ok && Array.isArray(r.value)) {
        const lines = r.value as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>
        const lastAssistant = [...lines].reverse().find((l) => l.role === 'assistant')
        const text = (lastAssistant?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        if (text !== '') await this.replyText(userId, text.slice(0, 3500))
      }
      return
    }
    if (frame.ev.type === 'approval/requested') {
      const requestId = String(frame.ev.requestId ?? '')
      const sensitive = String(frame.ev.kind ?? '') === 'sensitive'
      const tool = String(frame.ev.tool ?? '')
      const preview = String(frame.ev.preview ?? '').replace(/```/g, '｀｀｀').slice(0, 400)
      // T7 审批短码：随机 4 位数字 + preview 指纹（截断下仍可核对）；resolved 即作废
      // 撞码重摇（并发审批 4 位码 ~1/9000——静默覆盖=前一审批经 IM 不可应答）
      let code = String(randomInt(1000, 10000))
      while (this.approvalCodes.has(code)) code = String(randomInt(1000, 10000))
      this.approvalCodes.set(code, { requestId, sessionId: frame.sessionId, userId, expiresAt: Date.now() + APPROVAL_CODE_TTL_MS })
      const head = sensitive ? '⚠ 敏感操作（不可记住）' : '需要审批'
      await this.replyText(userId, `${head}\n工具：${tool}\n${preview}\n\n回复「${code} y」允许 /「${code} n」拒绝（短码 15 分钟内有效）`)
      return
    }
    if (frame.ev.type === 'approval/resolved') {
      const outcome = String(frame.ev.outcome ?? '')
      for (const [code, entry] of this.approvalCodes) {
        if (entry.requestId === requestIdOf(frame.ev)) this.approvalCodes.delete(code)
      }
      if (outcome !== '') {
        const zh = outcome === 'once' || outcome === 'always' ? `已${outcome === 'always' ? '始终' : ''}允许` : outcome === 'reject' ? '已拒绝' : outcome === 'timeout' ? '已超时自动拒绝' : outcome
        await this.replyText(userId, `审批终态：${zh}`)
      }
    }
  }

  // ———————————————— 发送 ————————————————
  private async replyText(userId: string, text: string): Promise<void> {
    const ctx = this.contexts.get(userId)
    if (ctx === undefined || ctx.token === '') {
      this.deps.logger.warn('im', 'wechat_no_context', { userId })
      return
    }
    try {
      await this.callApi('/ilink/bot/sendmessage', {
        msg: {
          to_user_id: userId,
          message_type: 2,
          message_state: 2,
          context_token: ctx.token,
          item_list: [{ type: 1, text_item: { text } }],
        },
      })
    } catch (e) {
      // context_token 过期/失效：本轮静默（记录——被动通道约束，无法补偿推送）
      this.deps.logger.warn('im', 'wechat_send_failed', { userId, message: e instanceof Error ? e.message : String(e) })
    }
  }

  private async callApi(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.api}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorizationtype: 'ilink_bot_token',
        authorization: `Bearer ${this.deps.botToken}`,
        'x-wechat-uin': Buffer.from(String(randomInt(0, 0xffffffff))).toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POLL_HOLD_MS + 15_000),
    })
    if (!res.ok) throw new Error(`iLink HTTP ${res.status}`)
    return (await res.json()) as unknown
  }
}

function requestIdOf(ev: { type: string; [k: string]: unknown }): string {
  return String(ev.requestId ?? '')
}
