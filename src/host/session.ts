/**
 * M12-B1 宿主会话：把 runLoop 的装配与驱动从 TuiApp/argv 收进宿主层（方案 §11.2 B1）。
 *
 * 职责：命令分发（prompt 三态/interrupt/插话清空）+ 事件翻译（loop callbacks → ProtocolEvent，
 * 经 InMemoryChannel 广播，seq 单调）+ 插话队列（host 权威，D2）+ 轮末兜底续投 + afterTools
 * （quality 回喂/autoCommit/后台任务通知）+ hooks（UserPromptSubmit/Stop）。
 *
 * 本批定位（绞杀者中间态）：TuiApp 不动（双路径并存），argv runOnce 先切换为宿主消费方——
 * 宿主正确性由事件序测试 + argv 真跑共同锁定。B2 换审批 Broker、B3 TUI 接入、B4 拆单例。
 *
 * B1 已知偏差（记录在案，后续批收口）：
 * - item/started 无真实工具 id（loop onToolStart 只给 name）——completed 用 onToolResult 的真实 id；
 * - 带图插话 mid-turn 不注入正文（pollUserInput 只回文本），持有到轮末兜底以 blocks 起轮——
 *   与 M11「标签随文本注入、图在续投时组装」语义等价但时点后移；
 * - argv 经宿主后新增 Stop hook 分发（原 runOnce 不发）——与 TUI 语义对齐，行为增强非回归。
 */

import { randomUUID } from 'node:crypto'
import { runLoop } from '../core/loop.js'
import { buildSystemPrompt } from '../core/system.js'
import type { HistoryLine, ImageBlock, Message } from '../core/types.js'
import { buildProviderReq, type Config } from '../services/config.js'
import { makeOnBeforeRequest } from '../services/compaction/hook.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { isMessageLine } from '../core/types.js'
import { ecodeCommit } from '../services/git.js'
import { makeSandbox } from '../services/sandbox.js'
import { buildMediaBlock } from '../services/media.js'
import { tokensToCost } from '../services/pricing.js'
import { taskRegistry } from '../services/tasks.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { HookRunner } from '../services/hooks/runner.js'
import { readFile } from 'node:fs/promises'
import { InMemoryChannel } from '../protocol/channel.js'
import type { CommandResult, ImagePayload, ProtocolCommand, ProtocolEvent } from '../protocol/types.js'
import { ApprovalBroker, type ApprovalPolicy } from './approval.js'
import { buildPreview } from '../services/preview.js'

/** buildSystemPrompt 的技能清单入参形态（结构化取参，避免依赖 skill 具体类型） */
type SkillPromptSource = Parameters<typeof buildSystemPrompt>[0]

export interface HostDeps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  config: Config
  orchestrator: CompactionOrchestrator
  skillListForPrompt: () => SkillPromptSource
  hookRunner?: HookRunner | null
  checkpoint?: { snapshot(sessionId: string, paths: string[], meta: { tool: string; messageId?: string }): Promise<unknown> } | null
  quality?: { afterRound(tools: { name: string; isError: boolean }[]): Promise<string | undefined>; lastRoundFailed?: boolean; tripped?: boolean } | null
  /** B1 过渡 confirm（B2 换 ApprovalBroker 后移除）——argv 不传=broker 策略接管 */
  cwd?: string
  /** D1：审批策略（ask=默认 fail-closed；auto-approve=argv --yes，仅 tool-confirm 豁免） */
  approvalPolicy?: ApprovalPolicy
}

interface QueueEntry {
  text: string
  /** D2：入队时预组装（带图插话在轮末兜底起轮时作为 userBlocks 附着） */
  blocks?: ImageBlock[]
  /** StartOrSteer（插话语义）=true：步间注入；StartIfIdle（排队语义）=false：轮末续投 */
  midTurn: boolean
}

export class HostSession {
  readonly channel = new InMemoryChannel()
  private readonly broker: ApprovalBroker
  /** 运行态沙箱档（Tab 切档经 sandbox/set 命令改此字段——B5 接线；confirm 策略消费） */
  private sandboxMode: 'default' | 'read-only' | 'workspace-write' | 'full-access'
  private readonly messages: HistoryLine[] = []
  private readonly editedFiles = new Set<string>()
  private readonly queue: QueueEntry[] = []
  private running = false
  private currentTurnId: string | null = null
  private abort = new AbortController()
  private ctxWindowCache: number | null = null
  private itemSeq = 0
  private idleResolvers: Array<() => void> = []

  constructor(private readonly deps: HostDeps) {
    this.channel.bind((cmd) => this.dispatch(cmd))
    this.broker = new ApprovalBroker(this.channel, deps.approvalPolicy ?? 'ask')
    this.sandboxMode =
      (deps.config.sandbox?.defaultMode as 'default' | 'read-only' | 'workspace-write' | 'full-access') ?? 'default'
  }

  /** 客户端订阅事件流（B2：订阅即重放 pending 可答帧——重连/换端恢复确认上下文） */
  subscribe(handler: (ev: ProtocolEvent) => void): () => void {
    const unsub = this.channel.subscribe(handler)
    this.broker.replayPending(handler)
    return unsub
  }

  /** 会话销毁：pending 审批 fail-closed 收敛 + 通道关闭 */
  dispose(): void {
    this.broker.dispose()
    this.abort.abort()
    this.channel.dispose()
  }

  send(cmd: ProtocolCommand): Promise<CommandResult> {
    return this.channel.send(cmd)
  }

  /** 等到空闲（argv 模式收尾用；含轮末兜底队列排空） */
  async whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve))
  }

  private notifyIdle(): void {
    const rs = this.idleResolvers
    this.idleResolvers = []
    for (const r of rs) r()
  }

  private publish(type: ProtocolEvent['type'], data: Record<string, unknown> = {}): void {
    this.channel.publish({ type, ...data } as Parameters<InMemoryChannel['publish']>[0])
  }

  private async dispatch(cmd: ProtocolCommand): Promise<CommandResult> {
    switch (cmd.op) {
      case 'prompt': {
        const blocks = cmd.images !== undefined && cmd.images.length > 0 ? await this.buildBlocks(cmd.images) : undefined
        if (this.running) {
          if (cmd.mode === 'StartIfIdle') {
            this.queue.push({ text: cmd.text, blocks, midTurn: false })
            this.publish('queue/snapshot', { items: this.queue.map((q) => q.text) })
            return { ok: true, routed: 'Queued' }
          }
          if (typeof cmd.mode === 'object' && cmd.mode.Steer.expectedTurnId !== this.currentTurnId) {
            return { ok: true, routed: 'Rejected' }
          }
          // StartOrSteer：busy 输入=插话（host 权威队列，D2）
          this.queue.push({ text: cmd.text, blocks, midTurn: true })
          this.publish('interjection/enqueued', { text: cmd.text })
          this.publish('queue/snapshot', { items: this.queue.map((q) => q.text) })
          return { ok: true, routed: 'Steered' }
        }
        void this.startTurn(cmd.text, blocks).catch(() => {})
        return { ok: true, routed: 'Started' }
      }
      case 'interrupt':
        this.abort.abort()
        return { ok: true }
      case 'interjection/clear':
        this.queue.length = 0
        this.publish('queue/snapshot', { items: [] })
        return { ok: true }
      case 'approval/respond': {
        const r = this.broker.respondApproval(cmd.requestId, cmd.decision)
        return r.accepted ? { ok: true } : { ok: false, error: r.reason ?? 'not-pending', code: 'NOT_PENDING' }
      }
      case 'askUser/respond': {
        const r = this.broker.respondAskUser(cmd.requestId, cmd.answers)
        return r.accepted ? { ok: true } : { ok: false, error: r.reason ?? 'not-pending', code: 'NOT_PENDING' }
      }
      case 'askSelect/respond': {
        const r = this.broker.respondAskSelect(cmd.requestId, cmd.choice)
        return r.accepted ? { ok: true } : { ok: false, error: r.reason ?? 'not-pending', code: 'NOT_PENDING' }
      }
      case 'sandbox/set':
        // 提权门槛（v1.2 P1-4）：提档 full-access 需经审批（有订阅者）；降档直接生效
        if (cmd.mode === 'full-access' && cmd.mode !== this.sandboxMode) {
          if (this.channel.subscriberCount === 0) {
            return { ok: false, error: '提档 full-access 需要客户端确认（当前无订阅者）', code: 'NEED_CLIENT' }
          }
          const ok = await this.broker.confirm(
            { type: 'tool_use', id: `sandbox-set-${Date.now()}`, name: 'sandbox/set', input: { mode: cmd.mode } },
            `沙箱提档 → full-access（确认后本会话副作用工具免确认）`,
          )
          if (!ok) return { ok: false, error: '用户拒绝提档', code: 'REJECTED' }
        }
        this.sandboxMode = cmd.mode
        return { ok: true }
      default:
        // B5（命令·会话·面板族）逐批接线
        return { ok: false, error: `命令 ${cmd.op} 尚未接线（B5 批次）`, code: 'NOT_IMPLEMENTED' }
    }
  }

  private async buildBlocks(images: ImagePayload[]): Promise<ImageBlock[] | undefined> {
    const blocks: ImageBlock[] = []
    for (const img of images) {
      try {
        const buf = await readFile(img.path)
        const ext = img.path.slice(img.path.lastIndexOf('.')).toLowerCase()
        const guard = buildMediaBlock(buf, ext, img.path)
        if (guard.ok && guard.block.type === 'image') blocks.push({ ...guard.block, _path: img.path })
      } catch {
        this.publish('notice', { level: 'warn', text: `图片读取失败被跳过：${img.path}` })
      }
    }
    return blocks.length > 0 ? blocks : undefined
  }

  private async startTurn(input: string, blocks?: ImageBlock[]): Promise<void> {
    const deps = this.deps
    if (deps.config.providers[deps.config.current.name] === undefined) {
      this.publish('systemMsg', { text: '配置不完整（/setup）' })
      return
    }
    this.running = true
    this.currentTurnId = randomUUID()
    this.abort = new AbortController()
    const turnId = this.currentTurnId
    // UserPromptSubmit hook（session_id 用真实会话 id——顺手修 TuiApp 侧硬编码 '' 的同源问题）
    if (deps.hookRunner != null && deps.hookRunner.hasHandlers('UserPromptSubmit')) {
      const verdict = await deps.hookRunner.dispatch('UserPromptSubmit', {
        event: 'UserPromptSubmit',
        session_id: deps.history.currentSessionId(),
        prompt: input,
      }, { signal: this.abort.signal })
      if (verdict.block) {
        this.publish('systemMsg', { text: `✋ 输入被 hook 拦截${verdict.reason !== undefined && verdict.reason !== '' ? `：${verdict.reason}` : ''}` })
        this.finishTurn(turnId)
        return
      }
      if (verdict.additionalContext.length > 0) input = `${input}\n\n[hook context]\n${verdict.additionalContext.join('\n')}`
    }
    // M10-P3 双时点之二：跨 turn 后台任务通知随首轮输入注入
    for (const n of taskRegistry.collectNotifications()) input = `${input}\n${n}`

    this.publish('turn/started', { turnId })
    this.publish('thread/status', { busy: true, waitingOn: null, iter: 0 })
    try {
      const provider = deps.providerRegistry.getByType(deps.config.providers[deps.config.current.name].type)
      const providerReq = buildProviderReq(deps.config)
      if (this.ctxWindowCache === null) {
        this.ctxWindowCache = await resolveContextWindow(
          deps.config.current.model,
          deps.config.providers[deps.config.current.name]?.contextWindow,
        )
      }
      const system = buildSystemPrompt(
        deps.skillListForPrompt(),
        this.ctxWindowCache,
        deps.config.maxInstructionsKB !== undefined ? { maxInstructionBytes: deps.config.maxInstructionsKB * 1024 } : undefined,
      )
      const onBeforeRequest = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, system, {
        onCompacted: () => this.publish('compacted', {}),
        history: deps.history,
        signal: this.abort.signal,
        onCompacting: () => this.publish('compacting', {}),
        onCompactFail: () => this.publish('compactFailed', {}),
        tools: deps.tools.specs(),
      })
      const cwd = deps.cwd ?? process.cwd()
      await runLoop(this.messages, input, {
        provider,
        tools: deps.tools,
        logger: deps.logger,
        history: deps.history,
        callbacks: {
          onText: (t) => this.publish('delta', { turnId, text: t }),
          onToolStart: (name) => this.publish('item/started', { itemId: `${turnId}-${++this.itemSeq}`, name }),
          onToolResult: (id, name, r) =>
            this.publish('item/completed', {
              itemId: id,
              name,
              isError: r.is_error === true,
              summary: (r.content as string).split('\n')[0]?.slice(0, 80) ?? '',
            }),
          onUsage: (inp, out, cache) => {
            const cost = tokensToCost(deps.config.current.model, {
              input: inp,
              output: out,
              cacheRead: cache?.read ?? 0,
              cacheCreation: cache?.creation ?? 0,
            })
            this.publish('usage', {
              input: inp,
              output: out,
              cacheRead: cache?.read,
              cacheCreation: cache?.creation,
              costUsd: cost ?? undefined,
            })
          },
          onIter: (i, m) => this.publish('thread/status', { busy: true, waitingOn: null, iter: i, maxIter: m } as Record<string, unknown>),
          onActivity: (state, text) => this.publish('activity', { state, text }),
          onWarn: (m) => this.publish('warn', { text: m }),
        },
        providerReq,
        system,
        maxIterations: deps.config.maxIterations,
        toolCtx: {
          cwd,
          signal: this.abort.signal,
          onBeforeWrite: async (paths, tool, toolUseId) => {
            for (const p of paths) this.editedFiles.add(p)
            await deps.checkpoint?.snapshot(deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
          },
          model: deps.config.current.model,
          sandbox: makeSandbox(
            (deps.config.sandbox?.defaultMode as 'default' | 'read-only' | 'workspace-write' | 'full-access') ?? 'default',
            cwd,
            deps.config.sandbox?.blockedCommands ?? [],
          ),
        },
        onBeforeRequest,
        onCompacted: () => this.publish('compacted', {}),
        // B2：审批经 Broker（doConfirm 的 full-access 跳过/read-only MCP 拒绝/预览生成在宿主侧策略）
        confirm: (use) => this.hostConfirm(use),
        onSensitiveAccess: (description: string) => this.broker.sensitive('read_file', description),
        ...(blocks !== undefined ? { userBlocks: blocks } : {}),
        afterTools: this.makeAfterTools(),
        signal: this.abort.signal,
        pollUserInput: () => {
          // 步间注入只吃插话语义（midTurn）且无图的条目；排队语义（StartIfIdle）与带图条目
          // 留给轮末兜底（带图以 blocks 起轮，见类头偏差记录）
          const injectable = this.queue.filter((q) => q.midTurn && q.blocks === undefined)
          if (injectable.length === 0) return null
          for (const q of injectable) {
            this.queue.splice(this.queue.indexOf(q), 1)
            this.publish('interjection/injected', { text: q.text })
          }
          this.publish('queue/snapshot', { items: this.queue.map((q) => q.text) })
          return injectable.map((q) => q.text).join('\n\n')
        },
      })
    } catch (e) {
      this.publish('error', { message: e instanceof Error ? e.message : String(e) })
    } finally {
      // Stop hook（对齐 TUI 语义；argv 经宿主后也获得——行为增强，记录在案）
      try {
        if (deps.hookRunner != null && deps.hookRunner.hasHandlers('Stop')) {
          await deps.hookRunner.dispatch('Stop', {
            event: 'Stop',
            session_id: deps.history.currentSessionId(),
            stop_reason: this.abort.signal.aborted ? 'aborted' : 'end',
          })
        }
      } catch {
        // Stop hook 失败不掩盖主结果（与 TuiApp 同款 fail-open 语义）
      }
      this.finishTurn(turnId)
    }
  }

  /** B2 宿主侧确认策略（doConfirm 语义迁入：full-access 跳过 / read-only MCP 拒绝 / 其余过 Broker） */
  private async hostConfirm(use: import('../core/types.js').ToolUseBlock): Promise<boolean> {
    if (this.sandboxMode === 'full-access') return true
    if (this.sandboxMode === 'read-only' && use.name.startsWith('mcp__')) {
      this.publish('systemMsg', { text: `read-only 模式：MCP 工具 ${use.name} 被拒绝` })
      return false
    }
    const preview = await buildPreview(use, this.deps.cwd ?? process.cwd()).catch(
      (e: unknown) => `⚠ 无法生成预览：${e instanceof Error ? e.message : String(e)}`,
    )
    return this.broker.confirm(use, preview)
  }

  private finishTurn(turnId: string): void {
    this.publish('turn/completed', { turnId })
    this.publish('thread/status', { busy: false, waitingOn: null, iter: 0 })
    this.running = false
    this.currentTurnId = null
    // 轮末兜底：队列续投（带图条目在此以 blocks 起轮）
    const next = this.queue.shift()
    if (next !== undefined) {
      this.publish('queue/snapshot', { items: this.queue.map((q) => q.text) })
      void this.startTurn(next.text, next.blocks).catch(() => {})
      return
    }
    this.notifyIdle()
  }

  /** afterTools（TuiApp makeAfterTools 的宿主版：quality 回喂 + autoCommit + 后台通知） */
  private makeAfterTools(): NonNullable<Parameters<typeof runLoop>[2]>['afterTools'] {
    return async (round) => {
      const deps = this.deps
      let feedback: string | undefined
      if (deps.quality != null) {
        const fb = await deps.quality.afterRound(round.tools)
        if (fb !== undefined) {
          this.publish('notice', { level: 'warn', text: 'lint/test 有失败，已回喂模型自纠' })
          feedback = fb
        }
      }
      const notes = taskRegistry.collectNotifications()
      const qualityBlocked = feedback !== undefined || deps.quality?.lastRoundFailed === true || deps.quality?.tripped === true
      if (this.deps.config.autoCommit === true && !qualityBlocked) {
        const files = [...this.editedFiles]
        this.editedFiles.clear()
        if (files.length > 0) {
          const lastAsst = [...this.messages].reverse().find((l): l is Message => isMessageLine(l) && l.role === 'assistant')
          const textBlock = lastAsst?.content.find((b) => b.type === 'text')
          const subject =
            textBlock !== undefined && 'text' in textBlock && textBlock.text.trim() !== ''
              ? `ecode: ${textBlock.text.trim().split('\n')[0]?.slice(0, 60)}`
              : `ecode: 修改 ${files.length} 个文件`
          const r = await ecodeCommit(this.deps.cwd ?? process.cwd(), deps.history.currentSessionId(), files, subject)
          this.publish('notice', { level: r.committed ? 'info' : 'warn', text: r.committed ? `已自动提交：${subject}` : `自动提交未完成——${r.reason ?? ''}` })
        }
      } else {
        this.editedFiles.clear()
      }
      const combined =
        feedback !== undefined ? (notes.length > 0 ? `${feedback}\n${notes.join('\n')}` : feedback) : notes.length > 0 ? notes.join('\n') : undefined
      return combined !== undefined ? { feedback: combined } : undefined
    }
  }
}
