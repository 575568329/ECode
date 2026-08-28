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

import { randomUUID, createHash } from 'node:crypto'
import { runLoop } from '../core/loop.js'
import { buildSystemPrompt } from '../core/system.js'
import type { HistoryLine, ImageBlock, Message } from '../core/types.js'
import { buildProviderReq, buildProviderReqFor, DEFAULT_NOTIFICATION_IDLE_SECONDS, type Config } from '../services/config.js'
import { makeOnBeforeRequest, type SummaryRole } from '../services/compaction/hook.js'
import { SUMMARY_WINDOW_FLOOR } from '../services/compaction/summarize.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { isMessageLine } from '../core/types.js'
import { ecodeCommit } from '../services/git.js'
import { makeSandbox } from '../services/sandbox.js'
import { buildMediaBlock } from '../services/media.js'
import { tokensToCost } from '../services/pricing.js'
import { TaskRegistry } from '../services/tasks.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { HookRunner } from '../services/hooks/runner.js'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { buildContextMessages } from '../core/context.js'
import { InMemoryChannel } from '../protocol/channel.js'
import type { CommandResult, ImagePayload, ProtocolCommand, ProtocolEvent } from '../protocol/types.js'
import { ApprovalBroker, type ApprovalPolicy } from './approval.js'
import { buildPreview } from '../services/preview.js'
import { setSubagentBridge, setSubagentProgressHandler, currentSubagentBridge, currentSubagentProgressHandler, type SubagentBridge } from '../services/subagent.js'
import { setPermissionAsker, currentPermissionAsker } from '../services/permissions.js'
import { redact } from '../services/redact.js'
import { setAskUserHandler, currentAskUserHandler, type AskUserHandler } from '../tools/builtin/askUserBridge.js'
import type { SkillHooksPort } from '../services/hooks/global.js'

/** buildSystemPrompt 的技能清单入参形态（结构化取参，避免依赖 skill 具体类型） */
type SkillPromptSource = Parameters<typeof buildSystemPrompt>[0]

/** M14-C1⑤：item/completed 帧内 content 上限（超出截断+truncated 标志，全文走 item/read） */
const ITEM_FRAME_CAP = 4096
/** M14-C1⑤：item/read 单响应上限（read_file 等可产出大内容——上限内才允许出宿主） */
const ITEM_READ_CAP = 1024 * 1024

/** 会话 id 合法形态（审阅 P0-1）：本项目 id 恒为 ISO 时间戳形态（`2026-08-27T22-31-05-123Z`，
 *  飞书 session/new 带 8 位随机后缀）。白名单而非黑名单——sessionId 会一路拼进文件路径
 *  （`join(dir, sessionId + '.jsonl')`），`..`/分隔符/绝对路径 = 任意 .jsonl 读写原语。 */
export function isValidSessionId(sid: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T[\w-]{1,64}$/.test(sid)
}

export interface HostDeps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  /** 运行态配置源（TUI /model·/config 切换后宿主取新值——getter 防陈旧闭包） */
  getConfig: () => Config
  orchestrator: CompactionOrchestrator
  skillListForPrompt: () => SkillPromptSource
  hookRunner?: HookRunner | null
  checkpoint?: { snapshot(sessionId: string, paths: string[], meta: { tool: string; messageId?: string }): Promise<unknown> } | null
  quality?: { afterRound(tools: { name: string; isError: boolean }[]): Promise<string | undefined>; lastRoundFailed?: boolean; tripped?: boolean } | null
  /** B1 过渡 confirm（B2 换 ApprovalBroker 后移除）——argv 不传=broker 策略接管 */
  cwd?: string
  /** D1：审批策略（ask=默认 fail-closed；auto-approve=argv --yes，仅 tool-confirm 豁免） */
  approvalPolicy?: ApprovalPolicy
  /** 上下文窗口提示（TUI 传启动预热情；缺省走 resolveContextWindow 联网/内置表） */
  ctxWindowHint?: () => number | null
  /** M13-W1：skill hooks 写端口（项目级 registry 绑定——skill 工具经 ctx.session 消费；缺省走模块兜底端口） */
  skillHooks?: SkillHooksPort
  /** M13-W2：restore=ensure 项目端口（session/restore 命令经此落 ProjectHost——活复用/冷载入/并发单飞）；
   *  缺省返回 NOT_IMPLEMENTED（argv/旧测试）。回执 value 含恢复的会话 id。 */
  ensureConversation?: (sessionId: string) => Promise<CommandResult>
  /** M13-W4：活会话运行态表（session/list 冷热合并——running 注入 meta 列表；缺省不注入） */
  conversationStates?: () => Map<string, boolean>
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
  /** B4：会话级后台任务表（ctx.tasks/ctx.session.tasks——多会话不串台；模块级全局仅兜底） */
  private readonly tasks = new TaskRegistry()
  private readonly subagentView = new Map<string, { id: string; description: string; activity: string }>()
  private readonly broker: ApprovalBroker
  /** 运行态沙箱档（Tab 切档经 sandbox/set 命令改此字段——B5 接线；confirm 策略消费） */
  private sandboxMode: 'default' | 'read-only' | 'workspace-write' | 'full-access'
  private readonly messages: HistoryLine[] = []
  private readonly editedFiles = new Set<string>()
  /** M13-B1（#4）：已读文件 mtime 表（readFileGuard 数据源——write/edit 后 mtime 变自然放行） */
  private readonly readMtime = new Map<string, number>()

  // —— M13-B2 loopGuard（#2 无效轮次检测：复读/同参/空错——阈值常量集中一处，D5 不入 config） ——
  private static readonly GUARD = { FP_WINDOW: 3, REPEAT_NUDGE: 1, REPEAT_ABORT: 3, SIG_NUDGE: 8, ERR_NUDGE: 5, ERR_ABORT: 8, TEXT_HEAD: 500 }
  private readonly guardFingerprints: string[] = [] // 最近 N 轮 assistant 文本指纹环
  private repeatStreak = 0
  private lastToolSig = ''
  private sigStreak = 0
  private sigNudged = false
  private errStreak = 0
  private turnHadTools = false
  private lastRoundLen = 0
  private roundUses: string[] = []
  private readonly queue: QueueEntry[] = []
  private running = false
  /** M14-C3③（P1-12）：prompt 已判定开轮、startTurn 尚未置 running 的同步占位——堵 buildBlocks 的 await 窗口 */
  private starting = false
  private currentTurnId: string | null = null
  private abort = new AbortController()
  private ctxWindowCache: number | null = null
  private itemSeq = 0
  private idleResolvers: Array<() => void> = []

  constructor(private readonly deps: HostDeps) {
    this.channel.bind((cmd) => this.dispatch(cmd))
    // M14-C2⑥ 审批审计：asked/decided 落 LogStore（asked 含 kind/tool；decided 含 outcome——产品化线设备审批留痕前置）
    // 批2d（§13.1 拍板-1）：审批挂起 N 秒未应答 → Notification hook（第七事件）触发一次
    const notifySeconds = deps.getConfig().notificationIdleSeconds ?? DEFAULT_NOTIFICATION_IDLE_SECONDS
    this.broker = new ApprovalBroker(this.channel, deps.approvalPolicy ?? 'ask', deps.getConfig().approvalTimeoutMs ?? 900_000, (event, info) => {
      deps.logger.info('approval', event, info)
    },
    (info) => { void this.dispatchNotification('approval-pending', info.kind, info.tool) },
    notifySeconds > 0 ? notifySeconds * 1000 : 0)
    this.sandboxMode =
      (this.cfg().sandbox?.defaultMode as 'default' | 'read-only' | 'workspace-write' | 'full-access') ?? 'default'
  }

  /** 客户端订阅事件流（B2：订阅即重放 pending 可答帧——重连/换端恢复确认上下文）。
   *  M14-C2⑧：canAnswer=false 的观察型订阅不计入审批 fail-closed 判定（透传通道语义） */
  subscribe(handler: (ev: ProtocolEvent) => void, opts: { canAnswer?: boolean } = {}): () => void {
    const unsub = this.channel.subscribe(handler, opts)
    this.broker.replayPending(handler)
    return unsub
  }

  /** 会话销毁：pending 审批 fail-closed 收敛 + 桥卸载 + 通道关闭 */
  dispose(): void {
    this.cancelIdleNotification() // 批2d：会话关闭清理（定时器不越界触发）
    this.tasks.dispose()
    this.broker.dispose()
    this.abort.abort()
    // M13-W1 归属守卫：模块槽是"最后挂载者"语义——仅当槽内仍是自己装的才清，
    // 防止 A 会话 dispose 误清后挂的 B 会话桥（多会话共存的正确卸载语义）。
    // M14-C3②：asker 槽键控（本会话 id）——其余桥仍单槽（消费域单一，串台面不存在）
    if (this.bridgesMounted) {
      const key = this.deps.history.currentSessionId()
      if (currentPermissionAsker(key) === this.installedAsker) setPermissionAsker(key, null)
      if (currentAskUserHandler() === this.installedAskUser) setAskUserHandler(null)
      if (currentSubagentBridge() === this.installedBridge) setSubagentBridge(null)
      if (currentSubagentProgressHandler() === this.installedProgress) setSubagentProgressHandler(null)
      this.bridgesMounted = false
    }
    this.channel.dispose()
  }

  /**
   * B3：三个模块级桥的宿主侧挂载（TuiApp/cli 调用；宿主测试不自动挂——避免模块单例串台）。
   * 挂载后子代理 confirm/权限 ask/ask_user 全部经 Broker 走可答帧——TUI 客户端只消费事件。
   */
  mountBridges(): void {
    if (this.bridgesMounted) return
    this.bridgesMounted = true
    this.installedAsker = async (owner, event) => this.broker.permission(owner, event)
    setPermissionAsker(this.deps.history.currentSessionId(), this.installedAsker)
    this.installedAskUser = (async (questions: Parameters<AskUserHandler>[0]) => {
      const r = await this.broker.askUser(questions)
      return (r ?? { kind: 'cancel' }) as ReturnType<AskUserHandler>
    }) as AskUserHandler
    setAskUserHandler(this.installedAskUser)
    this.installedBridge = {
      confirm: (use) => this.hostConfirm(use),
      warn: (m) => this.publish('notice', { level: 'warn', text: m }),
      usage: (inp, out, cache) => this.recordUsage(inp, out, cache), // 子代理成本归并（M12-P0 统一收口）
      onBeforeWrite: async (paths, tool, toolUseId) => {
        for (const p of paths) this.editedFiles.add(p)
        await this.deps.checkpoint?.snapshot(this.deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
      },
      getProviderReq: () => buildProviderReq(this.cfg()),
      getProvider: () => this.deps.providerRegistry.getByType(this.cfg().providers[this.cfg().current.name].type),
      getSandbox: () =>
        makeSandbox(this.sandboxMode, this.deps.cwd ?? process.cwd(), this.cfg().sandbox?.blockedCommands ?? []),
      getModel: () => this.cfg().current.model,
      // M14-C5②：子代理压缩链摘要换笔与主链同源（resolveSummaryRole 含缓存/floor 告警）
      getSummaryRole: () => this.resolveSummaryRole(),
    }
    setSubagentBridge(this.installedBridge)
    this.installedProgress = (agents) =>
      this.publish('subagent/progress', { agents: agents.map((a) => ({ id: a.id, description: a.description, activity: a.activity })) })
    setSubagentProgressHandler(this.installedProgress)
  }

  /** sweepIdle 只读视图（Q12：审批悬置不回收——broker 私有，经此暴露计数） */
  get brokerPending(): number {
    return this.broker.approvalPendingCount
  }

  /** M13-W2：运行态（loop 在跑或队列有货）——会话级 sweep 三闸之一（运行态永不收） */
  get isBusy(): boolean {
    return this.running || this.starting || this.queue.length > 0
  }

  /** B4（D5）：会话级子代理进度上报（task 工具经 ctx.session 调用；发布 subagent/progress 事件） */
  updateSubagent(st: { id: string; description: string; activity: string }): void {
    this.subagentView.set(st.id, st)
    this.publish('subagent/progress', { agents: [...this.subagentView.values()] })
  }

  removeSubagent(id: string): void {
    this.subagentView.delete(id)
    this.publish('subagent/progress', { agents: [...this.subagentView.values()] })
  }

  /**
   * M13-B1（#3）：skill 激活判定——扫**投影后** messages 的 tool_result 是否含
   * `<skill_content name="x">` 标记。按投影而非全量：/rewind 掉标记区间、压缩吃掉标记段后
   * 判定自动回未激活（与"消息即状态"同构，免内存 Set 的清理逻辑）。O(n) 一次、skill 调用低频可接受。
   */
  isSkillActive(name: string): boolean {
    const marker = `<skill_content name="${name}">`
    return buildContextMessages(this.messages).some(
      (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes(marker)),
    )
  }

  /** M13-B1（#4）：重复读守卫（ctx.session.readFileGuard 消费；宿主 stat 比对 mtime） */
  readonly readFileGuard = {
    /** true=已读且未变（工具侧跳过重复注入） */
    check: async (filePath: string): Promise<boolean> => {
      const mtimeMs = await stat(filePath).then((st) => st.mtimeMs, () => null)
      if (mtimeMs === null) return false // stat 失败放行（读取自身会报真实错误）
      return this.readMtime.get(filePath) === mtimeMs
    },
    /** 读取成功后记录（下次同 mtime 跳过） */
    record: async (filePath: string): Promise<void> => {
      const mtimeMs = await stat(filePath).then((st) => st.mtimeMs, () => null)
      if (mtimeMs !== null) this.readMtime.set(filePath, mtimeMs)
    },
  }

  /** B3（审阅 P0-3 修复）：/rewind 标记线注入宿主权威 messages（投影层据 rewind_to 跳过区间——
   *  客户端只写镜像时回退对 LLM 上下文不生效且下轮镜像覆盖丢失） */
  appendRewind(line: HistoryLine): void {
    this.messages.push(line)
  }

  /** B3：客户端恢复历史会话（宿主 messages 替换为载入内容；history 由调用方先行切 sessionId） */
  restoreFrom(lines: HistoryLine[]): void {
    this.messages.length = 0
    this.messages.push(...lines)
    this.mcpCallCount = 0 // 审阅 P1-1：会话切换计数归零（防旧累计值写进新会话文件致全局双计）
    this.readMtime.clear() // M13-B1：换会话已读表重置（旧会话的读取记录对新会话无意义）
  }

  /** B3：手动强制压缩（/compact——客户端命令面中间态实现；B5 升格为宿主命令） */
  async compactManual(): Promise<{ ok: boolean; reason?: string }> {
    const deps = this.deps
    const cfg = this.cfg()
    if (this.messages.length === 0) return { ok: false, reason: '无可压缩对话' }
    if (cfg.providers[cfg.current.name] === undefined) return { ok: false, reason: '配置无效' }
    const provider = deps.providerRegistry.getByType(cfg.providers[cfg.current.name].type)
    const providerReq = buildProviderReq(cfg)
    const maxKB = cfg.maxInstructionsKB
    const ctxWindow = this.ctxWindowCache ?? this.deps.ctxWindowHint?.() ?? 200_000
    const system = buildSystemPrompt(deps.skillListForPrompt(), ctxWindow, {
      ...(maxKB !== undefined ? { maxInstructionBytes: maxKB * 1024 } : {}),
      cwd: deps.cwd ?? process.cwd(),
    })
    const hook = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, system, {
      onCompacted: () => this.publish('compacted', {}),
      history: deps.history,
      tools: deps.tools.specs(),
      onUsage: (inp, out, cache) => this.recordUsage(inp, out, cache), // M12-P0：压缩漏账修复
      ...((r) => (r !== null ? { summary: r } : {}))(await this.resolveSummaryRole()), // M13-B3：摘要换笔（三项变更之②provider 替换）
    })
    try {
      await hook(this.messages, 'manual')
      return { ok: true }
    } catch (e) {
      this.publish('compactFailed', { detail: e instanceof Error ? e.message : String(e) })
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /** B3：同进程客户端重建转录用（TuiApp messagesToCommitted；B7 起换 session/read 命令） */
  get transcript(): readonly HistoryLine[] {
    return this.messages
  }

  private bridgesMounted = false
  /** M13-W1 桥归属守卫：本会话装进模块槽的四件闭包引用（dispose 时比对身份再清） */
  private installedAsker: ((owner: string, event: string) => Promise<import('../services/permissions.js').PermissionAnswer>) | null = null
  private installedAskUser: AskUserHandler | null = null
  private installedBridge: SubagentBridge | null = null
  private installedProgress: ((list: { id: string; description: string; activity: string }[]) => void) | null = null

  send(cmd: ProtocolCommand): Promise<CommandResult> {
    return this.channel.send(cmd)
  }

  /** 运行态配置（/model·/config 切换后取新值——B3 TUI 接线的前提） */
  private cfg(): Config {
    return this.deps.getConfig()
  }

  /**
   * M13-B3：roles.summary 分流解析（装配链换笔——provider/providerReq 替换 + summaryWindow）。
   * 窗口下限校验：resolveContextWindow 结果 < SUMMARY_WINDOW_FLOOR（批预算常量反算 2 倍余量）
   * → warn 一次并回退主模型（保底批也装不下，批批超限）。配置键缓存（含模型名——/model 不影响 roles）。
   */
  private summaryRoleCache: { key: string; value: SummaryRole | null } | null = null
  private summaryFloorWarned = false
  private async resolveSummaryRole(): Promise<SummaryRole | null> {
    const cfg = this.cfg()
    const role = cfg.roles?.summary
    if (role === undefined) return null
    const providerCfg = cfg.providers[role.provider]
    if (providerCfg === undefined) return null // loadConfig 已校验；此处防御（运行中配置被改）
    const key = `${role.provider}:${role.model}`
    if (this.summaryRoleCache?.key === key) return this.summaryRoleCache.value
    const provider = this.deps.providerRegistry.getByType(providerCfg.type)
    const providerReq = buildProviderReqFor(cfg, role.provider, role.model)
    const window = await resolveContextWindow(role.model, providerCfg.contextWindow)
    if (window < SUMMARY_WINDOW_FLOOR) {
      if (!this.summaryFloorWarned) {
        this.summaryFloorWarned = true
        this.deps.logger.warn('config', 'roles_summary_window', {
          message: `roles.summary 模型 ${role.model} 窗口 ${window} < 下限 ${SUMMARY_WINDOW_FLOOR}（批预算反算）——分流禁用回退主模型`,
        })
      }
      this.summaryRoleCache = { key, value: null }
      return null
    }
    const value = { provider, providerReq, window: Math.floor(window * 0.9) }
    this.summaryRoleCache = { key, value }
    return value
  }

  /** 等到空闲（argv 模式收尾用；含轮末兜底队列排空） */
  async whenIdle(): Promise<void> {
    if (!this.running && !this.starting && this.queue.length === 0) return
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve))
  }

  private notifyIdle(): void {
    const rs = this.idleResolvers
    this.idleResolvers = []
    for (const r of rs) r()
  }

  /**
   * M12-P0：会话内 MCP 调用计数（stats 行随帧快照落盘，聚合取每会话最后一条）。
   * 审阅 P2-5：四维/成本累计器是 write-only 死代码已删（stats 行写的是逐帧增量非累计值）。
   * 审阅 P1-1：会话切换（restoreFrom/session/clear）必须归零——否则旧会话累计值写进新会话文件致全局双计。
   */
  private mcpCallCount = 0

  private publish(type: ProtocolEvent['type'], data: Record<string, unknown> = {}): void {
    this.channel.publish({ type, ...data } as Parameters<InMemoryChannel['publish']>[0])
  }

  /**
   * M12-P0：会话 usage 统一收口——主循环回调与压缩链上报共用（计价 + 协议帧广播）。
   * 批2 将在此挂累计器与 stats 行落盘。
   */
  private recordUsage(inputTokens: number, outputTokens: number, cache?: { read?: number; creation?: number }): void {
    // 审阅 P0-2：pricing.ts 口径是人民币元（不换算防失真）——字段与展示全链路改 costCny/¥
    // 审阅 P2-4：透传 providers.pricing 配置覆盖（与 /cost 客户端重算同源）
    const cur = this.cfg()
    const cost = tokensToCost(cur.current.model, {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cache?.read ?? 0,
      cacheCreation: cache?.creation ?? 0,
    }, cur.providers[cur.current.name]?.pricing)
    this.publish('usage', {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cache?.read,
      cacheCreation: cache?.creation,
      costCny: cost ?? undefined,
    })
    // M12-P0：stats 行落盘（逐帧增量；mcpCalls 为会话内累计快照——聚合取每会话最后一条）
    this.deps.history.appendUsageStats({
      stats: true,
      ts: Date.now(),
      cwd: this.deps.cwd ?? process.cwd(),
      model: cur.current.model,
      input: inputTokens,
      output: outputTokens,
      cacheRead: cache?.read ?? 0,
      cacheCreation: cache?.creation ?? 0,
      costCny: cost ?? 0,
      costKnown: cost != null, // 审阅 P1-5：未收录定价不静默记 0
      mcpCalls: this.mcpCallCount,
    })
  }

  /** 审阅 P1-2：MCP 调用计数（主循环与子代理共用——子代理经 SessionPort.countMcpCall 上报） */
  private bumpMcp(): void {
    this.mcpCallCount++
  }

  private async dispatch(cmd: ProtocolCommand): Promise<CommandResult> {
    switch (cmd.op) {
      case 'prompt': {
        // M14-C3③（P1-12）：同步占位先于 buildBlocks 的 await——原检查在 await 后，带图 prompt
        // 并发双发会双双通过 running 检查双开轮；startTurn 同步段清 starting（早退路径也不泄漏）
        const idle = !this.running && !this.starting
        if (idle) this.starting = true
        const blocks = cmd.images !== undefined && cmd.images.length > 0 ? await this.buildBlocks(cmd.images) : undefined
        if (!idle) {
          // 复查：await 窗口内轮可能已结束（入口判定过时）——此刻已空闲则直接开轮，
          // 防插话入队后滞留无人 drain（whenIdle 死等；原被双开轮 bug 遮蔽的伴生竞态）
          if (!this.running && !this.starting) {
            void this.startTurn(cmd.text, blocks).catch((e: unknown) => {
              this.publish('error', { message: e instanceof Error ? e.message : String(e) })
              this.deps.logger.error('system', 'start_turn_failed', { message: e instanceof Error ? e.message : String(e) })
            })
            return { ok: true, routed: 'Started' }
          }
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
        void this.startTurn(cmd.text, blocks).catch((e: unknown) => {
          // 不静默吞（本轮实测：fake deps 缺方法时 TypeError 被吞成无响应）
          this.publish('error', { message: e instanceof Error ? e.message : String(e) })
          this.deps.logger.error('system', 'start_turn_failed', { message: e instanceof Error ? e.message : String(e) })
        })
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
        const r = this.broker.respondApproval(cmd.requestId, cmd.decision, cmd.message)
        return r.accepted ? { ok: true } : { ok: false, error: r.reason ?? 'not-pending', code: 'NOT_PENDING' }
      }
      case 'approval/claim': {
        // M14-C2⑤（D12 advisory）：多端同开时的认领可视——不改先答先得权威
        const r = this.broker.claim(cmd.requestId, cmd.claimant ?? 'client')
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
      case 'session/clear':
        // 宿主权威 messages 清空（客户端镜像/UI 瞬态由客户端自行重置——skill hooks 仍是模块级，B8a 会话化）
        this.messages.length = 0
        this.queue.length = 0
        this.editedFiles.clear()
        this.readMtime.clear() // M13-B1：已读表随会话重置
        this.mcpCallCount = 0 // 审阅 P1-1：与客户端 setSessionCost(0) 同语义
        return { ok: true }
      case 'session/restore':
        // M13-W2：restore=ensure（活复用/冷载入 restoreFrom/并发幂等单飞——落点 ProjectHost）
        if (!isValidSessionId(cmd.sessionId)) return { ok: false, error: `会话 id 非法：${cmd.sessionId}`, code: 'BAD_SESSION_ID' }
        if (this.deps.ensureConversation === undefined) {
          return { ok: false, error: '命令 session/restore 尚未接线（无 ProjectHost）', code: 'NOT_IMPLEMENTED' }
        }
        return this.deps.ensureConversation(cmd.sessionId)
      case 'session/list': {
        // M13-W4 冷热合并：历史 meta（冷）∪ 活会话 running 态（热）——前端一份列表两端状态。
        // cwd 过滤（审阅 P0-3②）：history 目录用户级全局，无过滤会把本机所有项目的会话
        // 全量返回给任一项目（web 端又无条件标注 selectedProject，跨项目会话混列）
        const states = this.deps.conversationStates?.()
        const metas = this.deps.history.loadAll(this.deps.cwd)
        if (states === undefined) return { ok: true, value: metas }
        return { ok: true, value: metas.map((m) => (states.has(m.sessionId) ? { ...m, running: states.get(m.sessionId) } : m)) }
      }
      case 'session/read':
        // M14-C1①a：分页带宽选项——fromLine/limit 是 **transcript 行索引**语义（原 beforeSeq 名义
        // 事件 seq，但 transcript 行与事件 seq 是两个 ID 空间，改名澄清）。缺省全量（web 断线
        // 全量补拉维持 M13-Q10 非目标不变）；带参返回 { lines, total, fromLine } 形态
        {
          // 审阅 P0-1：sessionId 进文件路径，白名单校验（黑名单必漏形态）
          if (!isValidSessionId(cmd.sessionId)) return { ok: false, error: `会话 id 非法：${cmd.sessionId}`, code: 'BAD_SESSION_ID' }
          const all = this.deps.history.restoreFull(cmd.sessionId)
          if (cmd.fromLine === undefined && cmd.limit === undefined) return { ok: true, value: all }
          const from = Math.max(0, Math.floor(cmd.fromLine ?? 0))
          const limit = Math.max(1, Math.floor(cmd.limit ?? 200))
          return { ok: true, value: { lines: all.slice(from, from + limit), total: all.length, fromLine: from } }
        }
      case 'item/read': {
        // M14-C1⑤：工具全文按需读取（帧内 4KB 截断的补全通道）。transcript 权威源——
        // messages 里 tool_use.id 命中后取其配对 tool_result；未落盘（运行中/不存在）404 语义
        const target = this.messages
          .filter(isMessageLine)
          .filter((l) => l.role === 'user')
          .flatMap((l) => (typeof l.content === 'string' ? [] : l.content))
          .find((b) => b.type === 'tool_result' && b.tool_use_id === cmd.itemId)
        if (target === undefined || target.type !== 'tool_result') {
          return { ok: false, error: `工具结果 ${cmd.itemId} 不存在或未落盘`, code: 'ITEM_NOT_FOUND' }
        }
        const content = typeof target.content === 'string' ? target.content : JSON.stringify(target.content)
        if (content.length > ITEM_READ_CAP) {
          return { ok: true, value: { content: content.slice(0, ITEM_READ_CAP), truncated: true } }
        }
        return { ok: true, value: { content } }
      }
      case 'model/set': {
        // 切模型（web 顶栏/协议面；TUI /model 走客户端本地 setConfig 不经此）。getConfig 是
        // 活引用——改 current 后下一轮 provider/getProvider/ctxWindow 即取新值（TUI 同语义）；
        // config/changed 广播经 redact（apiKey 不出会话通道）
        const cfg = this.cfg()
        const prov = cfg.providers[cmd.provider]
        if (prov === undefined) return { ok: false, error: `provider 不存在：${cmd.provider}`, code: 'BAD_PROVIDER' }
        if (!prov.models.includes(cmd.model)) return { ok: false, error: `模型 ${cmd.model} 不在 provider ${cmd.provider} 的列表中`, code: 'BAD_MODEL' }
        cfg.current = { name: cmd.provider, model: cmd.model }
        this.publish('config/changed', { config: redact(cfg) })
        this.deps.logger.info('system', 'model_set', { provider: cmd.provider, model: cmd.model })
        return { ok: true }
      }
      case 'config/get':
        // 脱敏视图（web 顶栏读 current/models；apiKey 永不出 serve 通道——5.2 铁律）
        return { ok: true, value: redact(this.cfg()) }
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
    this.starting = false // M14-C3③：dispatch 已同步置位；startTurn 到首个 await 前同步清（配置不完整早退也不泄漏占位）
    this.cancelIdleNotification() // 批2d：用户开新轮=不再空闲，idle 通知表作废
    const deps = this.deps
    if (this.cfg().providers[this.cfg().current.name] === undefined) {
      this.publish('systemMsg', { text: '配置不完整（/setup）' })
      this.notifyIdle() // M14-C3③：starting 窗口内挂起的 whenIdle 等待者（此早退不置 running，不归 finishTurn 收敛）
      return
    }
    this.running = true
    this.turnHadTools = false
    this.lastRoundLen = this.messages.length
    this.roundUses = []
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
    for (const n of this.tasks.collectNotifications()) input = `${input}\n${n}`

    this.publish('turn/started', { turnId })
    this.publish('thread/status', { busy: true, waitingOn: null, iter: 0 })
    try {
      const provider = deps.providerRegistry.getByType(this.cfg().providers[this.cfg().current.name].type)
      const providerReq = buildProviderReq(this.cfg())
      // 局部量承接（属性跨 await 的窄化会丢）
      const ctxWindow =
        this.ctxWindowCache ??
        this.deps.ctxWindowHint?.() ??
        (this.ctxWindowCache = await resolveContextWindow(
          this.cfg().current.model,
          this.cfg().providers[this.cfg().current.name]?.contextWindow,
        ))
      const maxKB = this.cfg().maxInstructionsKB
      const system = buildSystemPrompt(deps.skillListForPrompt(), ctxWindow, {
        ...(maxKB !== undefined ? { maxInstructionBytes: maxKB * 1024 } : {}),
        cwd: deps.cwd ?? process.cwd(),
      })
      const onBeforeRequest = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, system, {
        onCompacted: () => this.publish('compacted', {}),
        history: deps.history,
        signal: this.abort.signal,
        onCompacting: () => this.publish('compacting', {}),
        onCompactFail: () => this.publish('compactFailed', {}),
        tools: deps.tools.specs(),
        onUsage: (inp, out, cache) => this.recordUsage(inp, out, cache), // M12-P0：压缩漏账修复
        ...((r) => (r !== null ? { summary: r } : {}))(await this.resolveSummaryRole()), // M13-B3：摘要换笔（三项变更之②provider 替换）
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
          onToolResult: (id, name, r) => {
            this.turnHadTools = true
            if (name.startsWith('mcp__')) this.bumpMcp() // M12-P0：MCP 调用计数（随下一条 stats 行落盘）
            const use = this.messages
              .filter(isMessageLine)
              .filter((l) => l.role === 'assistant')
              .flatMap((l) => l.content)
              .find((b) => b.type === 'tool_use' && b.id === id)
            // M13-B2：同参检测原料（name+input 精确签名——D3 同款精确匹配零误伤；D4 记变体：
            // use 块在事件翻译层现成，免 PostToolUse hook 的项目级跨会话路由）
            if (use !== undefined && use.type === 'tool_use') this.roundUses.push(`${use.name}:${JSON.stringify(use.input)}`)
            // M14-C1⑤ 工具全文 summary+read 分野：帧内 content 截断 4KB（mux 全文出帧=LAN 旁听面，
            // MB 级输出也拖累每连接带宽）；全文走 item/read 按需（transcript 权威源）
            const full = r.content as string
            const truncated = full.length > ITEM_FRAME_CAP
            this.publish('item/completed', {
              itemId: id,
              name,
              isError: r.is_error === true,
              summary: full.split('\n')[0]?.slice(0, 80) ?? '',
              content: truncated ? full.slice(0, ITEM_FRAME_CAP) : full,
              ...(truncated ? { truncated: true } : {}),
              ...(use !== undefined ? { use: use as unknown } : {}),
            })
          },
          onUsage: (inp, out, cache) => this.recordUsage(inp, out, cache),
          onIter: (i, m) => this.publish('thread/status', { busy: true, waitingOn: null, iter: i, maxIter: m } as Record<string, unknown>),
          onActivity: (state, text) => this.publish('activity', { state, text }),
          onWarn: (m) => this.publish('warn', { text: m }),
        },
        providerReq,
        system,
        maxIterations: this.cfg().maxIterations,
        toolCtx: {
          cwd,
          session: {
            tasks: this.tasks,
            updateSubagent: (st) => this.updateSubagent(st),
            removeSubagent: (id) => this.removeSubagent(id),
            confirmTool: (use) => this.hostConfirm(use),
            askUser: async (qs) => {
              const r = await this.broker.askUser(qs)
              return (r ?? null) as unknown
            },
            // 审阅 P1-2/P1-4：子代理 usage 与 MCP 计数走会话窄端口（多宿主不串台）；模块桥降兜底
            recordUsage: (i, o, c) => this.recordUsage(i, o, c),
            countMcpCall: () => this.bumpMcp(),
            // M13-W1：skill hooks 写端口（项目级 registry 绑定；缺省走模块兜底——argv/旧测试）
            ...(this.deps.skillHooks !== undefined ? { skillHooks: this.deps.skillHooks } : {}),
            // M13-B1：skill 去重判定 + 重复读守卫（会话级；无宿主路径缺省不去重）
            isSkillActive: (name) => this.isSkillActive(name),
            readFileGuard: this.readFileGuard,
            // M13 审阅 R1：子代理快照/沙箱会话化（本会话 history.currentSessionId——多会话不串台）
            onBeforeWrite: async (paths, tool, toolUseId) => {
              for (const p of paths) this.editedFiles.add(p)
              await this.deps.checkpoint?.snapshot(this.deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
            },
            getSandbox: () =>
              makeSandbox(this.sandboxMode, this.deps.cwd ?? process.cwd(), this.cfg().sandbox?.blockedCommands ?? []),
            // 审阅 P0-3：运行态四 getter 会话化（模块桥单槽进程级会被多项目覆盖——此处随
            // 发起会话携带正确宿主的 config/providerRegistry/摘要角色）
            getProviderReq: () => buildProviderReq(this.cfg()),
            getProvider: () => this.deps.providerRegistry.getByType(this.cfg().providers[this.cfg().current.name].type),
            getModel: () => this.cfg().current.model,
            getSummaryRole: () => this.resolveSummaryRole(),
            // 审阅 P1-4：发起会话 id（hook 权限 asker 键随会话路由，不再走项目级 sessionRef）
            getSessionId: () => this.deps.history.currentSessionId(),
          },
          tasks: this.tasks,
          signal: this.abort.signal,
          onBeforeWrite: async (paths, tool, toolUseId) => {
            for (const p of paths) this.editedFiles.add(p)
            await deps.checkpoint?.snapshot(deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
          },
          model: this.cfg().current.model,
          // 运行态档位（sandbox/set 可切；config.defaultMode 仅初始值——审阅 P0-2：焊死 config 档致 Tab 切档失效）
          sandbox: makeSandbox(this.sandboxMode, cwd, this.cfg().sandbox?.blockedCommands ?? []),
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
            stop_reason: this.abort.signal.aborted ? 'aborted' : 'turn-complete',
          })
        }
      } catch {
        // Stop hook 失败不掩盖主结果（与 TuiApp 同款 fail-open 语义）
      }
      this.finishTurn(turnId)
    }
  }

  /** B2 宿主侧确认策略（doConfirm 语义迁入：full-access 跳过 / read-only MCP 拒绝 / 其余过 Broker） */
  private async hostConfirm(use: import('../core/types.js').ToolUseBlock): Promise<boolean | string> {
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
    if (!this.turnHadTools) this.loopGuardTextTurn() // M13-B2：纯文本轮复读（onWarn 通道）
    this.publish('turn/completed', { turnId })
    this.publish('thread/status', { busy: false, waitingOn: null, iter: 0 })
    this.running = false
    this.currentTurnId = null
    // 轮末兜底：队列续投（带图条目在此以 blocks 起轮）。
    // 中断态不续投（Ctrl+C「无法中断」根因：断掉当前轮后这里立刻用队列条目起新轮，
    // 看似模型停不下来）；队列保留（CC 同款中断不弃队列——下一轮 pollUserInput 步间注入或用户再提交时消费）
    const next = this.abort.signal.aborted ? undefined : this.queue.shift()
    if (this.abort.signal.aborted && this.queue.length > 0) {
      this.publish('systemMsg', { text: `已中断（插话队列保留 ${this.queue.length} 条，下轮自动注入；Ctrl+U 清空）` })
    }
    if (next !== undefined) {
      this.publish('queue/snapshot', { items: this.queue.map((q) => q.text) })
      void this.startTurn(next.text, next.blocks).catch((e: unknown) => {
        // 兜底续投失败不留哑轮（与首轮同款：发 error 事件 + 记日志）
        this.publish('error', { message: e instanceof Error ? e.message : String(e) })
        this.deps.logger.error('system', 'turn_failed', { message: e instanceof Error ? e.message : String(e) })
        this.notifyIdle()
      })
      return
    }
    this.scheduleIdleNotification()
    this.notifyIdle()
  }

  // —— 批2d（§13.1 拍板-1）：Notification hook（第七事件）——
  // 触发条件（拍板 b：挂起 N 秒后触发，防高频）：审批挂起 N 秒未应答（broker 定时器回调）+
  // 空闲等待用户输入 N 秒（轮末 finishTurn 起表、新 prompt 取消）。N=config.notificationIdleSeconds
  // （默认 60，0=关）。低开销跳过（对齐其余六事件的 hasHandlers 快速路径）：idle 在起表时查、
  // approval-pending 在挂起触发时刻查——无 handler 不起表/不 dispatch。
  private idleNotifyTimer: ReturnType<typeof setTimeout> | null = null

  /** 轮末空闲起表：N 秒后仍无新 prompt → Notification(idle) 触发一次（表在 startTurn 清——新轮=不再空闲） */
  private scheduleIdleNotification(): void {
    this.cancelIdleNotification()
    const seconds = this.deps.getConfig().notificationIdleSeconds ?? DEFAULT_NOTIFICATION_IDLE_SECONDS
    const runner = this.deps.hookRunner
    if (seconds <= 0 || runner == null || !runner.hasHandlers('Notification')) return
    this.idleNotifyTimer = setTimeout(() => {
      this.idleNotifyTimer = null
      void this.dispatchNotification('idle')
    }, seconds * 1000)
    this.idleNotifyTimer.unref?.()
  }

  private cancelIdleNotification(): void {
    if (this.idleNotifyTimer !== null) {
      clearTimeout(this.idleNotifyTimer)
      this.idleNotifyTimer = null
    }
  }

  /** Notification 统一出口（fail-open：hook 失败只告警——与 Stop 同款旁路观测语义） */
  private async dispatchNotification(reason: 'idle' | 'approval-pending', kind?: string, tool?: string): Promise<void> {
    const runner = this.deps.hookRunner
    if (runner == null || !runner.hasHandlers('Notification')) return
    try {
      await runner.dispatch('Notification', {
        event: 'Notification',
        session_id: this.deps.history.currentSessionId(),
        reason,
        ...(reason === 'approval-pending' && tool !== undefined ? { tool_name: tool } : {}),
        ...(reason === 'approval-pending' && kind !== undefined ? { tool_input: { kind } } : {}),
      })
    } catch (e) {
      this.deps.logger.warn('hooks', 'notification_failed', { reason, message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** afterTools（TuiApp makeAfterTools 的宿主版：loopGuard 检测 + quality 回喂 + autoCommit + 后台通知） */
  private makeAfterTools(): NonNullable<Parameters<typeof runLoop>[2]>['afterTools'] {
    return async (round) => {
      const deps = this.deps
      let feedback: string | undefined
      // M13-B2：无效轮次检测先行（feedback/abort 注入在 quality 之前——止损优先）
      const guardFb = this.loopGuardRound(round)
      if (guardFb !== undefined) feedback = guardFb
      if (deps.quality != null) {
        const fb = await deps.quality.afterRound(round.tools)
        if (fb !== undefined) {
          this.publish('notice', { level: 'warn', text: 'lint/test 有失败，已回喂模型自纠' })
          feedback = fb
        }
      }
      const notes = this.tasks.collectNotifications()
      const qualityBlocked = feedback !== undefined || deps.quality?.lastRoundFailed === true || deps.quality?.tripped === true
      if (this.cfg().autoCommit === true && !qualityBlocked) {
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

  /**
   * M13-B2（#2）三检测器（工具轮——afterTools 时点；纯文本轮复读在 finishTurn）：
   * 跨 Turn 复读（指纹环精确匹配，D3）/ 同参工具（name+input 签名连续相同）/ 连续空错。
   * 阈值：复读提醒 ×2 后第 3 次 abort；同参连 8 提醒后仍不变 abort；空错连 5 提醒连 8 abort。
   * 公共约束（文章同款）：指纹/签名/错误形态一变即清零重计；触发记 LogStore(loop-guard)；abort 前
   * systemMsg 给用户可读原因；feedback 带 [loop-guard] 前缀（transcript 可识别）。
   */
  private loopGuardRound(round: { tools: Array<{ name: string; isError: boolean }> }): string | undefined {
    const G = HostSession.GUARD
    let feedback: string | undefined
    if (round.tools.length === 0) return undefined

    // ① 同参工具：本轮签名（排序去序敏感）与上轮连续相同
    const sig = [...this.roundUses].sort().join('|')
    this.roundUses = []
    if (sig !== '' && sig === this.lastToolSig) this.sigStreak++
    else {
      this.lastToolSig = sig
      this.sigStreak = 1
      this.sigNudged = false
    }
    if (this.sigStreak >= G.SIG_NUDGE) {
      if (this.sigNudged) {
        this.guardAbort('same-args', '连续多轮以完全相同的参数调用同一工具且提醒无效')
        return '[loop-guard] 检测到同参数工具循环，本轮已终止。请更换方法或工具。'
      }
      this.sigNudged = true
      this.deps.logger.warn('loop-guard', 'same-args', { streak: this.sigStreak })
      feedback = `[loop-guard] 最近 ${this.sigStreak} 轮在以完全相同的参数调用相同工具，请重新判断这是否必要。`
    }

    // ② 连续空错：全 isError 非空轮
    if (round.tools.every((t) => t.isError)) {
      this.errStreak++
      if (this.errStreak >= G.ERR_ABORT) {
        this.guardAbort('all-error', `连续 ${this.errStreak} 轮工具全部失败`)
        return (feedback !== undefined ? `${feedback}\n[loop-guard] ` : '[loop-guard] ') + `连续失败 ${this.errStreak} 轮，本轮已终止。请更换思路或基于已有信息回答。`
      }
      if (this.errStreak >= G.ERR_NUDGE) {
        this.deps.logger.warn('loop-guard', 'all-error', { streak: this.errStreak })
        const nudge = `[loop-guard] 已连续 ${this.errStreak} 轮工具全部失败，请更换思路或基于已有信息回答。`
        feedback = feedback !== undefined ? `${feedback}\n${nudge}` : nudge
      }
    } else this.errStreak = 0

    // ③ 跨 Turn 复读（工具轮）：本轮 assistant 文本指纹与最近 N 轮比对
    const text = this.assistantTextSince(this.lastRoundLen)
    this.lastRoundLen = this.messages.length
    if (text !== '') {
      const fp = createHash('sha256').update(text.slice(0, G.TEXT_HEAD)).digest('hex')
      if (this.guardFingerprints.includes(fp)) {
        this.repeatStreak++
        if (this.repeatStreak >= G.REPEAT_ABORT) {
          this.guardAbort('repeat', `最近 ${this.repeatStreak + 1} 轮输出高度重复`)
          return (feedback !== undefined ? `${feedback}\n` : '') + '[loop-guard] 输出高度重复，本轮已终止。请更换方法或工具。'
        }
        if (this.repeatStreak >= G.REPEAT_NUDGE) {
          this.deps.logger.warn('loop-guard', 'repeat', { streak: this.repeatStreak })
          const nudge = `[loop-guard] 最近 ${this.repeatStreak + 1} 轮输出高度重复，请更换方法或工具。`
          feedback = feedback !== undefined ? `${feedback}\n${nudge}` : nudge
        }
      } else this.repeatStreak = 0
      this.guardFingerprints.push(fp)
      if (this.guardFingerprints.length > G.FP_WINDOW) this.guardFingerprints.shift()
    }
    return feedback
  }

  /** 纯文本轮复读检测（finishTurn 时点——afterTools 只在工具轮触发）：onWarn 用户可见 */
  private loopGuardTextTurn(): void {
    const text = this.assistantTextSince(this.lastRoundLen)
    this.lastRoundLen = this.messages.length
    if (text === '') return
    const fp = createHash('sha256').update(text.slice(0, HostSession.GUARD.TEXT_HEAD)).digest('hex')
    if (this.guardFingerprints.includes(fp)) {
      this.repeatStreak++
      if (this.repeatStreak >= HostSession.GUARD.REPEAT_ABORT) {
        this.guardAbort('repeat', `最近 ${this.repeatStreak + 1} 轮输出高度重复`)
        return
      }
      this.publish('warn', { text: `[loop-guard] 最近 ${this.repeatStreak + 1} 轮输出高度重复（纯文本），请更换话题或方法。` })
      this.deps.logger.warn('loop-guard', 'repeat-text', { streak: this.repeatStreak })
    } else this.repeatStreak = 0
    this.guardFingerprints.push(fp)
    if (this.guardFingerprints.length > HostSession.GUARD.FP_WINDOW) this.guardFingerprints.shift()
  }

  /** messages[start..] 中 assistant 文本拼接（复读指纹原料） */
  private assistantTextSince(start: number): string {
    return this.messages
      .slice(start)
      .filter(isMessageLine)
      .filter((l) => l.role === 'assistant')
      .flatMap((l) => l.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }

  /** 检测 abort：断信号 + systemMsg 可读原因 + 日志（loop 心脏零改动——signal 它本来就在听） */
  private guardAbort(detector: string, reason: string): void {
    this.abort.abort()
    this.deps.logger.warn('loop-guard', 'abort', { detector, reason })
    this.publish('systemMsg', { text: `⚠ [loop-guard] ${reason}，已终止本轮。` })
  }
}
