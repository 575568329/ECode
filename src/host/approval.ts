/**
 * M12-B2 审批中介（方案 §3.3 + D6 分策略表）：一切「要客户端作答」的交互统一走挂起式可答帧。
 *
 * 语义四支柱：
 * - **可答帧**：approval/askUser/askSelect requested 带 randomUUID 的 requestId；应答走统一
 *   respond 命令；权威结果经 resolved 广播（多订阅者收敛，HTTP 形态断线重放 pending）。
 * - **fail-closed**：零订阅者=无应答渠道，一律拒绝（auto-approve 策略只豁免 tool-confirm，
 *   sensitive/mcp-permission 永不豁免——D6：--yes 不放开密钥外泄面）。
 * - **级联**：always 仅 MCP server 前缀粒度（对齐 TuiApp confirmAlwaysRef 语义，不扩工具类）；
 *   reject 级联拒绝本会话全部 pending tool-confirm（opencode 同款）。
 * - **消毒**：所有随帧下发的 preview 统一过 sanitizePreview（P1-3：preview 宿主侧生成即消毒）。
 */

import { randomUUID } from 'node:crypto'
import type { InMemoryChannel } from '../protocol/channel.js'
import { sanitizePreview } from '../services/preview.js'
import type { ApprovalDecision, ApprovalKind, ProtocolEvent, PublishableEvent } from '../protocol/types.js'
import type { ToolUseBlock } from '../core/types.js'

/** argv 审批策略（D1）：ask=默认（无订阅者 fail-closed）；auto-approve=--yes（仅 tool-confirm 豁免） */
export type ApprovalPolicy = 'ask' | 'auto-approve'

interface PendingEntry {
  requestId: string
  kind: ApprovalKind
  frame: ProtocolEvent
  resolve: (value: unknown) => void
  /** M13-B2 审批超时定时器（respond/dispose 清；触发=自动 reject + resolved('timeout')） */
  timer?: ReturnType<typeof setTimeout>
  /** 批2d：挂起通知定时器（应答/超时/级联/dispose 清——同一挂起只通知一次） */
  notifyTimer?: ReturnType<typeof setTimeout>
  /** M14-C2⑤ 审批 claim（D12 advisory）：认领方与租约到期时刻——不改先答先得权威语义，纯可视 */
  claim?: { claimant: string; expiresAt: number }
}

/** 可答帧的构造形态（不含 seq——通道分配；requestId 为公共字段） */
type AnswerableFrame = PublishableEvent & { requestId: string; kind?: ApprovalKind }

/** 审批审计落盘（M14-C2⑥）：asked（挂起登记后）/decided（respond/timeout/dispose 收敛） */
export type ApprovalAuditSink = (event: 'asked' | 'decided', info: Record<string, unknown>) => void

/** 批2d（§13.1 拍板-1）：审批挂起 N 秒未应答的通知回调（宿主接线 → Notification hook dispatch） */
export type ApprovalPendingNotifier = (info: { requestId: string; kind: string; tool: string }) => void

/** claim 租约时长（D12：CC 300s 租约先例取半——认领端崩溃后最多 2 分钟可被重新认领/他人应答提示恢复） */
const CLAIM_TTL_MS = 120_000

export interface PermissionAnswer {
  allow: boolean
  remember: boolean
}

/** F-07 档A：可给「本会话记住此工具」第三键的内置工具（edit_file/write_file） */
export const REMEMBER_TOOLS = new Set(['edit_file', 'write_file'])

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly confirmAlways = new Set<string>()
  /** F-07 档A：会话级内置工具白名单（edit_file/write_file 按 a 键放行——同集合互通，
   *  once 前无差别；新会话即新 broker 实例，天然不残留） */
  private readonly rememberTools = new Set<string>()

  constructor(
    private readonly channel: InMemoryChannel,
    private readonly policy: ApprovalPolicy = 'ask',
    /** M13-B2：挂起超时毫秒（config.approvalTimeoutMs；0=不限——默认值由宿主层填） */
    private readonly timeoutMs = 0,
    /** M14-C2⑥：审计落盘钩子（宿主接 LogStore——设备审批留痕是产品化线前置） */
    private readonly audit: ApprovalAuditSink | null = null,
    /** 批2d（§13.1 拍板-1）：挂起通知——审批挂起 N 秒未应答触发一次（应答/超时/级联/dispose 取消定时器） */
    private readonly pendingNotifier: ApprovalPendingNotifier | null = null,
    /** 批2d：挂起通知阈值毫秒（0=关；<0 视为关——防御非法配置） */
    private readonly notifyDelayMs = 0,
  ) {}

  get pendingCount(): number {
    return this.pending.size
  }

  /** sweepIdle 只读视图（Q12：审批悬置不回收——broker 私有，经此暴露计数） */
  get approvalPendingCount(): number {
    return this.pending.size
  }

  /** F-07 档A：会话级工具 remember 集合只读视图（宿主 hostConfirm 直放判定） */
  get rememberedTools(): ReadonlySet<string> {
    return this.rememberTools
  }

  /** F-07 档A：清空会话级 remember 集合（/clear、session/clear——换会话语义不残留） */
  clearRememberedTools(): void {
    this.rememberTools.clear()
  }

  private get hasSubscriber(): boolean {
    return this.channel.subscriberCount > 0
  }

  private publish(frame: AnswerableFrame): ProtocolEvent {
    return this.channel.publish(frame)
  }

  /** 工具副作用确认（tool-confirm）。preview 由宿主生成（buildPreview；此处出口再消毒兜底）。
   *  返回 false=无名拒绝；返回 string=拒绝反馈（喂回模型——对标 A1：模型不再瞎猜取消原因）
   *  F-07 档A：canAlways=true（宿主已判 edit/write 且非敏感路径）时卡带 always 第三键；
   *  rememberTools 命中直放（会话级白名单——sensitive 硬门在宿主 canAlways 判定处，命中者不入此路径）
   *  D9：signal=当轮 abort 信号——中断即收敛挂起（不等审批超时），循环得以随 abort 解开。 */
  confirm(use: ToolUseBlock, preview: string, canAlways = false, signal?: AbortSignal): Promise<boolean | string> {
    const mcpPrefix = use.name.startsWith('mcp__') ? use.name.split('__').slice(0, 2).join('__') : null
    if (mcpPrefix !== null && this.confirmAlways.has(mcpPrefix)) return Promise.resolve(true)
    // F-07 档A：remember 集合的**直放判定不在 broker**（此处不知 path 敏感性）——宿主
    // hostConfirm 判 sensitive 后自行直放；broker 只负责存集合 + always 级联
    if (!this.hasSubscriber && this.policy === 'auto-approve') return Promise.resolve(true)
    const requestId = randomUUID()
    const decisions: ApprovalDecision[] =
      mcpPrefix !== null || (canAlways && REMEMBER_TOOLS.has(use.name)) ? ['once', 'always', 'reject'] : ['once', 'reject']
    const frame: AnswerableFrame = {
      type: 'approval/requested',
      requestId,
      kind: 'tool-confirm',
      tool: use.name,
      preview: sanitizePreview(preview),
      decisions,
    }
    if (!this.hasSubscriber) {
      // fail-closed：无应答渠道。仍留事件轨迹（requested+cancelled）供日志与迟到的重放审计
      this.publish(frame)
      this.publish({ type: 'approval/resolved', requestId, outcome: 'cancelled' })
      return Promise.resolve(false)
    }
    return this.suspendOnce(frame, (v) => (typeof v === 'string' && v !== '' ? v : v === true), signal)
  }

  /** 敏感路径读取确认（sensitive）：永远要求交互，auto-approve 不豁免（D6）。 */
  sensitive(tool: string, description: string, signal?: AbortSignal): Promise<boolean | string> {
    const requestId = randomUUID()
    const frame: AnswerableFrame = {
      type: 'approval/requested',
      requestId,
      kind: 'sensitive',
      tool,
      preview: sanitizePreview(description),
      decisions: ['once', 'reject'],
    }
    if (!this.hasSubscriber) {
      this.publish(frame)
      this.publish({ type: 'approval/resolved', requestId, outcome: 'cancelled' })
      return Promise.resolve(false)
    }
    return this.suspendOnce(frame, (v) => (typeof v === 'string' && v !== '' ? v : v === true), signal)
  }

  /** 扩展 hook 首次执行授权（mcp-permission）：auto-approve 不豁免（第三方面不可控）。 */
  permission(owner: string, event: string, signal?: AbortSignal): Promise<PermissionAnswer> {
    const requestId = randomUUID()
    const frame: AnswerableFrame = {
      type: 'approval/requested',
      requestId,
      kind: 'mcp-permission',
      tool: `hook:${owner}`,
      preview: `扩展 ${owner} 申请在 ${event} 事件执行 hook（首次）`,
      decisions: ['once', 'always', 'reject'],
    }
    if (!this.hasSubscriber) {
      this.publish(frame)
      this.publish({ type: 'approval/resolved', requestId, outcome: 'cancelled' })
      return Promise.resolve({ allow: false, remember: false })
    }
    return this.suspendOnce(frame, (v) => v as PermissionAnswer, signal)
  }

  /** ask_user 问询（B3b 接线）：无订阅者回 null（工具侧已有非交互守卫文案） */
  askUser(questions: unknown[]): Promise<unknown> {
    const requestId = randomUUID()
    const frame: AnswerableFrame = { type: 'askUser/requested', requestId, questions }
    if (!this.hasSubscriber) {
      this.publish(frame)
      this.publish({ type: 'askUser/resolved', requestId, answers: null })
      return Promise.resolve(null)
    }
    return this.suspendOnce(frame, (v) => v)
  }

  /** 通用单选（B5 /skill-create 等）：choice=null 表示取消 */
  askSelect(title: string, options: string[]): Promise<string | null> {
    const requestId = randomUUID()
    const frame: AnswerableFrame = { type: 'askSelect/requested', requestId, title, options }
    if (!this.hasSubscriber) {
      this.publish(frame)
      this.publish({ type: 'askSelect/resolved', requestId, choice: null })
      return Promise.resolve(null)
    }
    return this.suspendOnce(frame, (v) => v as string | null)
  }

  /** 挂起并登记（respond 侧触发 resolve）：**先登记后广播**——订阅者可能在同步回调里立刻
   *  respond，登记晚一步就会 not-pending 丢失应答（集成测试实测死锁教训）。
   *  D9：signal（当轮 abort）中止即收敛本条挂起——fail-closed 解析 + resolved('cancelled')，
   *  Ctrl+C 不再被「无人应答的卡」拖住（此前只能等审批超时）。 */
  private suspendOnce<T>(frame: AnswerableFrame, adapt: (v: unknown) => T, signal?: AbortSignal): Promise<T> {
    const requestId = frame.requestId
    return new Promise<T>((resolve) => {
      const entry: PendingEntry = {
        requestId,
        kind: frame.kind ?? 'ask-user',
        frame: frame as ProtocolEvent,
        resolve: (v) => resolve(adapt(v)),
      }
      this.pending.set(requestId, entry)
      entry.frame = this.publish(frame) // 广播后回填带 seq 的完整帧（重放源）
      this.audit?.('asked', { requestId, kind: entry.kind, tool: (frame as { tool?: string }).tool ?? '' })
      // M13-B2：超时自动 reject（resolved 带 'timeout' 轨迹；unref 不占事件循环——测试短时限可调）
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => this.timeoutResolve(requestId), this.timeoutMs)
        entry.timer.unref?.()
      }
      // 批2d（§13.1 拍板-1）：挂起 N 秒未应答通知一次（fire 时刻 entry 已被收走则自然 no-op）；
      // unref 同上——通知是旁路观测，绝不拖住进程退出。
      // 批2d-fix（审阅 P1-1 自续环防御）：mcp-permission 不挂通知表——扩展源 Notification hook 若
      // 处于 ask 态，通知 dispatch 会挂起新权限卡，新卡再触发 approval-pending，形成通知→权限→通知环。
      if (this.pendingNotifier !== null && this.notifyDelayMs > 0 && entry.kind !== 'mcp-permission') {
        const notifier = this.pendingNotifier // 闭包快照（TS 收窄——构造后不变）
        entry.notifyTimer = setTimeout(() => {
          const cur = this.pending.get(requestId)
          if (cur !== entry) return // 已应答/超时/级联收敛——不再打扰
          notifier({
            requestId,
            kind: entry.kind,
            tool: (frame as { tool?: string }).tool ?? '',
          })
        }, this.notifyDelayMs)
        entry.notifyTimer.unref?.()
      }
      // D9：轮中断收敛（signal 由宿主按当轮传入——controller 每轮新建，挂起随轮存活）
      if (signal !== undefined) {
        if (signal.aborted) {
          this.cancelPending(requestId)
          return
        }
        signal.addEventListener('abort', () => this.cancelPending(requestId), { once: true })
      }
    })
  }

  /** D9：单条挂起的取消收敛（中断/dispose 面）——清定时器、fail-closed 解析、
   *  resolved('cancelled') 广播 + 审计。语义与超时收敛同构，仅 outcome 不同。 */
  private cancelPending(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return
    this.pending.delete(requestId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.notifyTimer !== undefined) clearTimeout(entry.notifyTimer)
    if (entry.kind === 'mcp-permission') entry.resolve({ allow: false, remember: false })
    else if (entry.kind === 'ask-select' || entry.kind === 'ask-user') entry.resolve(null)
    else entry.resolve(false)
    this.audit?.('decided', { requestId, kind: entry.kind, outcome: 'cancelled' })
    if (entry.kind === 'tool-confirm' || entry.kind === 'sensitive' || entry.kind === 'mcp-permission') {
      this.publish({ type: 'approval/resolved', requestId, outcome: 'cancelled' })
    } else if (entry.kind === 'ask-user') {
      this.publish({ type: 'askUser/resolved', requestId, answers: null })
    } else {
      this.publish({ type: 'askSelect/resolved', requestId, choice: null })
    }
  }

  /** M14-C2⑤ 认领（D12 advisory）：登记租约并广播 claimed 帧。不改权威语义——
   *  非认领方仍可 respond（防劫持），认领方崩溃由 TTL 过期自愈。重复 claim 刷新租约。 */
  claim(requestId: string, claimant: string): { accepted: boolean; reason?: string } {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    entry.claim = { claimant, expiresAt: Date.now() + CLAIM_TTL_MS }
    this.publish({ type: 'approval/claimed', requestId, claimant })
    return { accepted: true }
  }

  /** 当前有效 claim（过期视为无——惰性判定，无需清理定时器） */
  private activeClaim(entry: PendingEntry): { claimant: string } | null {
    if (entry.claim === undefined) return null
    return entry.claim.expiresAt > Date.now() ? entry.claim : null
  }

  /** 超时收敛：无人应答的挂起按 kind 给默认拒绝值 + resolved('timeout')（多端延迟答审批的止损） */
  private timeoutResolve(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return
    this.pending.delete(requestId)
    // 批2d-fix（审阅 P2）：timeout 先收敛时显式清通知表（原靠 fire 前 no-op 兜底——防御重复触发口径统一）
    if (entry.notifyTimer !== undefined) clearTimeout(entry.notifyTimer)
    if (entry.kind === 'mcp-permission') entry.resolve({ allow: false, remember: false })
    else if (entry.kind === 'ask-select') entry.resolve(null)
    else if (entry.kind === 'ask-user') entry.resolve(null)
    else entry.resolve(false)
    this.audit?.('decided', { requestId, kind: entry.kind, outcome: 'timeout' })
    if (entry.kind === 'tool-confirm' || entry.kind === 'sensitive' || entry.kind === 'mcp-permission') {
      this.publish({ type: 'approval/resolved', requestId, outcome: 'timeout' })
    } else if (entry.kind === 'ask-user') {
      this.publish({ type: 'askUser/resolved', requestId, answers: null })
    } else {
      this.publish({ type: 'askSelect/resolved', requestId, choice: null })
    }
  }

  /** approval/respond 命令处理：回执 accepted；权威结果经 resolved 广播。
   *  message=拒绝反馈（decision==='reject' 时透传给挂起方——喂回模型） */
  respondApproval(requestId: string, decision: ApprovalDecision, message?: string): { accepted: boolean; reason?: string } {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    const tool = (entry.frame as { tool: string }).tool
    const mcpPrefix = tool.startsWith('mcp__') ? tool.split('__').slice(0, 2).join('__') : null
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.notifyTimer !== undefined) clearTimeout(entry.notifyTimer)
    this.pending.delete(requestId)
    if (decision === 'always') {
      if (mcpPrefix !== null) this.confirmAlways.add(mcpPrefix)
      else if (REMEMBER_TOOLS.has(tool)) this.rememberTools.add(tool) // F-07 档A：会话级工具白名单
      entry.resolve(true)
      // 级联：同前缀的其余 pending 自动放行；rememberTools 命中时其余 pending 中
      // **卡面本身带 always**（宿主已判非敏感路径）的 edit/write 一并放行——敏感卡无
      // always 键，天然不会被级联波及（M14-D6 sensitive 永远交互不破）
      if (mcpPrefix !== null || this.rememberTools.size > 0) {
        for (const [id, p] of [...this.pending]) {
          const f = p.frame as { tool: string; decisions?: string[] }
          const pMcp = f.tool.startsWith('mcp__') ? f.tool.split('__').slice(0, 2).join('__') : null
          const hit = mcpPrefix !== null ? pMcp === mcpPrefix : this.rememberTools.size > 0 && REMEMBER_TOOLS.has(f.tool) && (f.decisions?.includes('always') ?? false)
          if (p.kind === 'tool-confirm' && hit) {
            if (p.timer !== undefined) clearTimeout(p.timer)
            if (p.notifyTimer !== undefined) clearTimeout(p.notifyTimer)
            this.pending.delete(id)
            p.resolve(true)
            this.publish({ type: 'approval/resolved', requestId: id, outcome: 'once' })
          }
        }
      }
    } else if (decision === 'reject') {
      const feedback = typeof message === 'string' && message.trim() !== '' ? message.trim() : false
      entry.resolve(feedback)
      // 级联：本会话全部 pending tool-confirm 一并拒绝（opencode 同款语义；连带拒无具体理由=false）
      for (const [id, p] of [...this.pending]) {
        if (p.kind === 'tool-confirm') {
          if (p.timer !== undefined) clearTimeout(p.timer)
          if (p.notifyTimer !== undefined) clearTimeout(p.notifyTimer)
          this.pending.delete(id)
          p.resolve(false)
          this.publish({ type: 'approval/resolved', requestId: id, outcome: 'reject' })
        }
      }
    } else {
      entry.resolve(true)
    }
    this.audit?.('decided', { requestId, kind: entry.kind, outcome: decision, message })
    this.publish({ type: 'approval/resolved', requestId, outcome: decision })
    return { accepted: true }
  }

  respondAskUser(requestId: string, answers: unknown): { accepted: boolean; reason?: string } {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.notifyTimer !== undefined) clearTimeout(entry.notifyTimer)
    this.pending.delete(requestId)
    entry.resolve(answers)
    this.publish({ type: 'askUser/resolved', requestId, answers })
    return { accepted: true }
  }

  respondAskSelect(requestId: string, choice: string | null): { accepted: boolean; reason?: string } {
    const entry = this.pending.get(requestId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.notifyTimer !== undefined) clearTimeout(entry.notifyTimer)
    this.pending.delete(requestId)
    entry.resolve(choice)
    this.publish({ type: 'askSelect/resolved', requestId, choice })
    return { accepted: true }
  }

  /** 重连重放：把仍 pending 的可答帧原样（含 requestId）重投给新订阅者（SSE 场景）。
   *  M14-C2⑤：有效 claim 的租约随帧一并重放（断线重连端能看到"已在某端处理"状态） */
  replayPending(handler: (ev: ProtocolEvent) => void): void {
    for (const p of this.pending.values()) {
      handler(p.frame)
      const c = this.activeClaim(p)
      if (c !== null) handler({ type: 'approval/claimed', seq: 0, requestId: p.requestId, claimant: c.claimant })
    }
  }

  /** 实例销毁：全部 pending fail-closed 收敛（不留悬挂 Promise——opencode finalizer 同款） */
  dispose(): void {
    for (const [id, p] of [...this.pending]) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      if (p.notifyTimer !== undefined) clearTimeout(p.notifyTimer)
      this.pending.delete(id)
      if (p.kind === 'mcp-permission') p.resolve({ allow: false, remember: false })
      else if (p.kind === 'ask-select') p.resolve(null)
      else if (p.kind === 'ask-user') p.resolve(null)
      else p.resolve(false)
      this.audit?.('decided', { requestId: id, kind: p.kind, outcome: 'cancelled' })
      this.publish({ type: 'approval/resolved', requestId: id, outcome: 'cancelled' })
    }
  }
}
