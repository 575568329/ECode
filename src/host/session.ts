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
 * - item/started.itemId = 真实 tool_use id（活动流 B2 itemId 同源修复——旧合成 id 与 completed 不同源曾致 web 回填恒失败）；
 * - 带图插话 mid-turn 不注入正文（pollUserInput 只回文本），持有到轮末兜底以 blocks 起轮——
 *   与 M11「标签随文本注入、图在续投时组装」语义等价但时点后移；
 * - argv 经宿主后新增 Stop hook 分发（原 runOnce 不发）——与 TUI 语义对齐，行为增强非回归。
 */

import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { runLoop } from '../core/loop.js'
import { buildSystemPrompt } from '../core/system.js'
import type { HistoryLine, ImageBlock, Message, MessageMeta, RewindLine, ThinkingLine } from '../core/types.js'
import { makeToolDigest } from '../protocol/toolDigest.js'
import type { RewindExecResult, RewindListResult, SkillPanelView, McpPanelView } from '../protocol/types.js'
import { buildProviderReq, buildProviderReqFor, DEFAULT_NOTIFICATION_IDLE_SECONDS, type Config } from '../services/config.js'
import { makeOnBeforeRequest, type SummaryRole } from '../services/compaction/hook.js'
import { SUMMARY_WINDOW_FLOOR } from '../services/compaction/summarize.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { isBoundary, isMessageLine } from '../core/types.js'
import { ecodeCommit } from '../services/git.js'
import { makeSandbox, resolveReal, type SandboxMode } from '../services/sandbox.js'
import { isSensitivePath, isProjectEcodeSettings } from '../tools/sensitive.js'
import { buildMediaBlock } from '../services/media.js'
import { tokensToCost } from '../services/pricing.js'
import { callReviewer, buildReviewMessages, shouldReviewAtTurnEnd, longestConsecutiveErrorRun, shouldReviewOnSignal, DEFAULT_REVIEW_GATE_TIMEOUT_MS, type ReviewTrigger } from '../services/review/reviewer.js'
import { TaskRegistry, TASK_OUTPUT_MAX_WAIT_MS } from '../services/tasks.js'
import type { LLMProviderRegistry, LLMProvider, ProviderReq } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { HookRunner } from '../services/hooks/runner.js'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { buildContextMessages } from '../core/context.js'
import { InMemoryChannel } from '../protocol/channel.js'
import type { CommandResult, ImagePayload, ProtocolCommand, ProtocolEvent } from '../protocol/types.js'
import { ApprovalBroker, type ApprovalPolicy } from './approval.js'
import { REMEMBER_TOOLS } from './approval.js'
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
/** 2026-08-29：截断全文暂存环形缓冲。TUI 收到截断帧即回发 item/read 补全，而 tool_result 要等
 *  同轮全部工具结束才追加进 messages（并行池被慢兄弟拖住即踩空——dogfood 实测 MCP 网页工具几乎
 *  必中：输出恒超 4KB 帧）。宿主在 onToolResult 手里就有全文，暂存一份供 item/read 三源查询
 *  （暂存 → messages → 盘），把补全通道从「赌落盘赢过回程」变成确定性命中。 */
const RECENT_FULL_RING = 32
/** 单条暂存上限（超大结果不进环形缓冲防吃内存；此类走盘上 restoreFull 源） */
const RECENT_FULL_CAP = 512 * 1024

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
  checkpoint?: {
    snapshot(sessionId: string, paths: string[], meta: { tool: string; messageId?: string }): Promise<unknown>
    /** T1 rewind 宿主接线（协议面 list/exec）——结构兼容 CheckpointStore，装配层传真件 */
    list(sessionId: string): Promise<
      Array<{ seq: number; time: string; tool: string; messageId?: string; files: Array<{ path: string; hash: string }> }>
    >
    detectExternalChanges(sessionId: string, seq: number): Promise<string[]>
    revert(sessionId: string, seq: number): Promise<{ restored: string[]; externalChanged: string[] }>
    /** 二轮补遗（bash absent 兜底）：近修改集读取 + absent 补录（结构兼容 CheckpointStore） */
    bashDirtyFiles(): Promise<string[]>
    amendAbsent(sessionId: string, paths: string[]): Promise<void>
    /** T 线②：fork 续写的快照目录跟随（起新 id 后旧快照仍可用——CC copyFileHistoryForResume 同款） */
    copyForResume(oldSessionId: string, newSessionId: string): Promise<void>
  } | null
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
  /** F-23：命令面（serve/web 端 / 命令分流——host 可执行命令直接跑，TUI 专属明确报错；
   *  缺省不注册（argv/旧测试——斜杠输入走原 prompt 路径，行为不变） */
  commands?: import('../commands/registry.js').CommandRegistry
  /** F-23：/cost 宿主侧会话累计（TUI 由 usage 帧累计；serve 端命令分流本地累计） */
  costAccumulator?: () => number
  /** T1 面板数据窄口（panel/data + mcp/action + mcp/approve 的宿主侧能力面；
   *  View 契约冻结在 protocol/types——装配层从真件映射，宿主不 import 具体注册表类型） */
  panelData?: {
    skill: () => Promise<SkillPanelView> | SkillPanelView
    mcp: () => Promise<McpPanelView> | McpPanelView
    mcpAction?: (action: 'reconnect' | 'close', server: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    /** .mcp.json 批准门二段接入（approved=true 才实际注册工具；拒绝=仅记录） */
    approveMcp?: (file: string, approved: boolean) => Promise<void>
  }
  /** T1⑪：装配期告警（mcp/instruction）——宿主构造时转 notice 帧（附着态客户端不直读 deps 对象） */
  startupWarnings?: string[]
  /** T2（D-T7）：项目 .mcp.json 首用批准门——宿主构造时发起 askSelect 协议交互，approve() 二段接入 */
  mcpPendingApproval?: { file: string; approve: () => Promise<void> }
}

interface QueueEntry {
  text: string
  /** D2：入队时预组装（带图插话在轮末兜底起轮时作为 userBlocks 附着） */
  blocks?: ImageBlock[]
  /** StartOrSteer（插话语义）=true：步间注入；StartIfIdle（排队语义）=false：轮末续投 */
  midTurn: boolean
  /** 来源（审阅修复 2026-09-02）：'review'=纠偏审查卡（系统产物）——pollUserInput 走中性
   *  审查包装不冒充用户、轮末续投转 pendingReviewCard 不自动起轮、Ctrl+U 不清弃、
   *  queue/snapshot 只发摘要。缺省 'user'——既有插话/排队路径零变化 */
  kind?: 'user' | 'review'
  /** 中断后到达的输入（审阅修复）：中断广播使 running 仍 true 期间用户的新输入会被当
   *  插话入队——轮末中断分支对本标条目豁免（照常续投=新任务意图，旧插话仍保留不弃） */
  afterAbort?: boolean
  /** 机器消息标记（2026-09-03 归属根治 P2-1）：queue 条目起轮时透传为起轮消息 meta——
   *  当前全部条目是用户操作产物（缺省 undefined=用户消息）；为未来机器条目预留透传通道，
   *  防轮末兜底/排队路径重新引入冒充 */
  meta?: MessageMeta
}

export class HostSession {
  readonly channel = new InMemoryChannel()
  /** B4：会话级后台任务表（ctx.tasks/ctx.session.tasks——多会话不串台；模块级全局仅兜底）。
   *  审阅修复批改 public readonly：panel/data 'tasks' 测试需从宿主侧注入任务断言快照
   *  （只读语义——TaskRegistry 引用不换，不破坏封装） */
  readonly tasks = new TaskRegistry()
  private readonly subagentView = new Map<string, { id: string; description: string; activity: string; startedAt?: number; waitingSince?: number }>()
  private readonly broker: ApprovalBroker
  /** 运行态沙箱档（Tab 切档经 sandbox/set 命令改此字段——B5 接线；confirm 策略消费） */
  private sandboxMode: SandboxMode
  private readonly messages: HistoryLine[] = []
  private readonly editedFiles = new Set<string>()
  /** bash absent 兜底（二轮）：bash 前置 git status 快照（执行后差集用） */
  private bashPreDirty: string[] = []
  /** M13-B1（#4）：已读文件 mtime 表（readFileGuard 数据源——write/edit 后 mtime 变自然放行） */
  private readonly readMtime = new Map<string, number>()

  // —— M13-B2 loopGuard（#2 无效轮次检测：复读/同参/空错——阈值常量集中一处，D5 不入 config） ——
  // 审阅 P2-3：非 private——测试按 SIG_NUDGE 派生轮数（阈值调整不破测试）
  static readonly GUARD = { FP_WINDOW: 3, REPEAT_NUDGE: 1, REPEAT_ABORT: 3, SIG_NUDGE: 8, ERR_NUDGE: 5, ERR_ABORT: 8, TEXT_HEAD: 500 }
  private readonly guardFingerprints: string[] = [] // 最近 N 轮 assistant 文本指纹环
  private repeatStreak = 0
  private lastToolSig = ''
  private sigStreak = 0
  private sigNudged = false
  private errStreak = 0
  private turnHadTools = false
  private lastRoundLen = 0
  /** M13-B2：本轮工具签名原料（onToolResult 采集——M13-P1 起含 resultHead，签名=同参且同果） */
  private roundUses: string[] = []
  private readonly queue: QueueEntry[] = []
  /** 活跃轮 controller 集合（startTurn 登记/finishTurn 注销；interrupt 全集 abort——2026-09-02 Ctrl+C 立即停兜底） */
  private readonly activeAbortControllers = new Map<string, AbortController>()
  private running = false
  /** T 线⑥：SessionStart hook 的 additionalContext 宿主暂存（startTurn 首轮注入后清空） */
  private pendingSessionContext: string[] = []
  /** T1⑪：启动告警队列（首次订阅 flush——构造期无订阅者） */
  private pendingStartupWarnings: string[] = []
  /** T2：.mcp.json 批准门（首次订阅后发起——需有可应答订阅者才不会 fail-closed 秒回） */
  private pendingMcpApprovalGate?: { file: string; approve: () => Promise<void> }
  /** M14-C3③（P1-12）：prompt 已判定开轮、startTurn 尚未置 running 的同步占位——堵 buildBlocks 的 await 窗口 */
  private starting = false
  private currentTurnId: string | null = null
  private abort = new AbortController()
  private ctxWindowCache: number | null = null
  // 活动流 B2：思考块计时与文本累积（onThinking 记录 → onThinkingEnd 算时长落 ThinkingLine）
  private readonly thinkingStarts = new Map<number, number>()
  private readonly thinkingBufs = new Map<number, string>()
  /** 截断全文暂存（tool_use_id → 全文，插入序淘汰；item/read 第二源，见 RECENT_FULL_RING 注） */
  private recentFullResults = new Map<string, string>()
  private idleResolvers: Array<() => void> = []
  /** F-23：会话累计成本（/cost 宿主命令分流用；recordUsage 顺带累计） */
  private sessionCost = 0
  /** F-23：最近一次 usage 快照（/cost 宿主命令展示） */
  private lastIn = 0
  private lastOut = 0
  private lastCacheRead = 0
  private lastCacheCreation = 0

  constructor(private readonly deps: HostDeps) {
    this.channel.bind((cmd) => this.dispatch(cmd))
    // M14-C2⑥ 审批审计：asked/decided 落 LogStore（asked 含 kind/tool；decided 含 outcome——产品化线设备审批留痕前置）
    // 批2d（§13.1 拍板-1）：审批挂起 N 秒未应答 → Notification hook（第七事件）触发一次
    // D-T8（2026-08-31 拍板）：默认 15min→1h（手机端晚到应答是附着态核心场景）；超时反馈改如实语义（approval.ts）
    const notifySeconds = deps.getConfig().notificationIdleSeconds ?? DEFAULT_NOTIFICATION_IDLE_SECONDS
    this.broker = new ApprovalBroker(this.channel, deps.approvalPolicy ?? 'ask', deps.getConfig().approvalTimeoutMs ?? 3_600_000, (event, info) => {
      deps.logger.info('approval', event, info)
    },
    (info) => { void this.dispatchNotification('approval-pending', info.kind, info.tool) },
    notifySeconds > 0 ? notifySeconds * 1000 : 0)
    this.sandboxMode =
      (this.cfg().sandbox?.defaultMode as SandboxMode) ?? 'default'
    // T 线⑥：SessionStart(startup) 宿主化——宿主构造=会话宿主首次诞生（原 TUI 挂载 effect 的
    // 客户端 dispatch 移入；fork 恢复路径的 resume 走 session/restore fork 分支的 dispatchSessionStart）
    this.dispatchSessionStart('startup', deps.history.currentSessionId())
    // T1⑪：装配期告警**不在构造时发布**——订阅者（附着客户端）在构造之后才挂上，即时发必丢；
    // 存队列随首次订阅 flush（pendingStartupWarningsFlushed 幂等）
    this.pendingStartupWarnings = deps.startupWarnings ?? []
    // T 线 T2：项目 .mcp.json 首用批准门宿主协议化——askSelect 可答帧经协议下发（TUI/web 同构
    // 弹选择），应答回宿主二段接入。原 TuiApp 直调 deps.mcpPendingApproval.approve() 的同进程
    // 捷径退役（附着态 MCP manager 在 daemon，此门必须过协议——D-T7 拍板）。
    // 发起延迟到首次订阅（构造期零订阅者时 askSelect 走 fail-closed 立即 null——时序同 T1⑪）
    if (deps.mcpPendingApproval !== undefined) this.pendingMcpApprovalGate = deps.mcpPendingApproval
  }

  /** bash absent 兜底（二轮审阅）：bash 前置 git status 暂存，执行后差集补 absent 进最近快照点 */
  private async bashCapturePre(): Promise<void> {
    this.bashPreDirty = this.deps.checkpoint != null ? await this.deps.checkpoint.bashDirtyFiles() : []
  }

  private async bashAmendAbsent(): Promise<void> {
    const cp = this.deps.checkpoint
    if (cp == null) return
    const post = await cp.bashDirtyFiles()
    const pre = new Set(this.bashPreDirty)
    this.bashPreDirty = []
    const created = post.filter((p) => !pre.has(p))
    if (created.length > 0) await cp.amendAbsent(this.deps.history.currentSessionId(), created)
  }

  /** .mcp.json 批准门交互（宿主权威）：askSelect 挂起→应答→approve() 二段接入或拒绝留痕 */
  private async runMcpApprovalGate(pending: { file: string; summary?: string; approve: () => Promise<void> }): Promise<void> {
    // 审阅修复（安全席 P1·二轮）：批准卡带内容摘要——server 清单+环境变量引用名（http 型 headers 的密钥外传面可见；
    // 原卡只显示文件路径，用户盲批即外传）
    const desc = pending.summary !== undefined && pending.summary !== '' ? `：${pending.summary}` : ''
    const pick = await this.broker.askSelect(`批准项目级 ${pending.file}${desc}？（含 MCP server 定义；stdio 型可 spawn 子进程，http 型会向上述地址发请求）`, [
      '批准并连接',
      '本次会话不连接',
    ])
    if (pick !== null && pick.startsWith('批准')) {
      try {
        await pending.approve()
        this.deps.logger.info('mcp', 'approve_gate', { file: pending.file, approved: true })
        this.publish('systemMsg', { text: '✓ 已批准并接入项目级 MCP server' })
      } catch (e) {
        this.publish('systemMsg', { text: '接入失败：' + (e instanceof Error ? e.message : String(e)) })
      }
    } else {
      this.deps.logger.info('mcp', 'approve_gate', { file: pending.file, approved: false })
      this.publish('systemMsg', { text: '（本次会话未连接项目级 MCP；下次启动会再询问）' })
    }
  }

  /** 客户端订阅事件流（B2：订阅即重放 pending 可答帧——重连/换端恢复确认上下文）。
   *  M14-C2⑧：canAnswer=false 的观察型订阅不计入审批 fail-closed 判定（透传通道语义） */
  subscribe(handler: (ev: ProtocolEvent) => void, opts: { canAnswer?: boolean } = {}): () => void {
    const unsub = this.channel.subscribe(handler, opts)
    this.broker.replayPending(handler)
    // T1⑪：启动告警随**每个新订阅**补发（构造期无订阅者即时发必丢；审阅 P2——双端场景
    // 后连的客户端也要看到，per-subscriber 一次而非全局幂等一次）
    for (const w of this.pendingStartupWarnings) handler({ type: 'notice', seq: -1, level: 'warn', text: w } as never)
    if (this.pendingMcpApprovalGate !== undefined) {
      const gate = this.pendingMcpApprovalGate
      this.pendingMcpApprovalGate = undefined
      void this.runMcpApprovalGate(gate)
    }
    return unsub
  }

  /** 会话销毁：pending 审批 fail-closed 收敛 + 桥卸载 + 通道关闭 */
  dispose(): void {
    // 审阅修复：残留活跃轮 controller 全断+清集合（会话回收时 loop 不再向已 dispose 的 channel publish）
    for (const c of [...this.activeAbortControllers.values()]) {
      try {
        c.abort()
      } catch {
        /* 幂等 */
      }
    }
    this.activeAbortControllers.clear()
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
    // 审阅修复批（2026-08-31 四角色）：提档卡/权限卡入串行队列+接当轮 signal——
    // 否则与工具卡并存时仍会顶掉 TUI 单槽卡（D9 残余路径），中断也不收敛
    this.installedAsker = (owner, event) => this.enqueueConfirm(() => this.broker.permission(owner, event, this.abort.signal))
    setPermissionAsker(this.deps.history.currentSessionId(), this.installedAsker)
    this.installedAskUser = (async (questions: Parameters<AskUserHandler>[0]) => {
      const r = await this.broker.askUser(questions)
      return (r ?? { kind: 'cancel' }) as ReturnType<AskUserHandler>
    }) as AskUserHandler
    setAskUserHandler(this.installedAskUser)
    this.installedBridge = {
      // 审阅修复批（2026-08-31 四角色）：子代理 confirm 透传当轮 signal——中断后子代理卡
      // 同样立即收敛（此前悬空至 900s 审批超时成僵尸卡）
      confirm: (use) => this.hostConfirm(use, this.abort.signal),
      warn: (m) => this.publish('notice', { level: 'warn', text: m }),
      usage: (inp, out, cache) => this.recordUsage(inp, out, cache), // 子代理成本归并（M12-P0 统一收口）
      onBeforeWrite: async (paths, tool, toolUseId) => {
        for (const p of paths) this.editedFiles.add(p)
        if (tool === 'bash' || tool === 'bash-background') await this.bashCapturePre()
        await this.deps.checkpoint?.snapshot(this.deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
      },
      onAfterBash: () => this.bashAmendAbsent(),
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
      this.publish('subagent/progress', { agents: agents.map((a) => ({ id: a.id, description: a.description, activity: a.activity, ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}), ...(a.waitingSince !== undefined ? { waitingSince: a.waitingSince } : {}) })) })
    setSubagentProgressHandler(this.installedProgress)
  }

  /** sweepIdle 只读视图（Q12：审批悬置不回收——broker 私有，经此暴露计数） */
  get brokerPending(): number {
    return this.broker.approvalPendingCount
  }

  /** F-07 档A：会话级 remember 集合只读视图（hostConfirm 直放判定用） */
  get rememberedTools(): ReadonlySet<string> {
    return this.broker.rememberedTools
  }

  /** F-07 档A：清空会话级 remember 集合（/clear、session/clear——换会话语义不残留） */
  clearRememberedTools(): void {
    this.broker.clearRememberedTools()
  }

  /** M13-W2：运行态（loop 在跑或队列有货）——会话级 sweep 三闸之一（运行态永不收） */
  get isBusy(): boolean {
    return this.running || this.starting || this.queue.length > 0
  }

  /** 批 4（W-9）：断线游标重放——channel 缓冲帧（seq > since）；mux 端点 per-conversation 调用 */
  replaySince(since: number): { events: ProtocolEvent[]; coveredFrom: number } {
    return this.channel.replaySince(since)
  }

  /** 批 4（W-9）：当前会话已分配 seq——订阅基线（客户端据此检测通道重建/seq 回绕） */
  get lastSeq(): number {
    return this.channel.lastSeq
  }

  /** B4（D5）：会话级子代理进度上报（task 工具经 ctx.session 调用；发布 subagent/progress 事件）。
   *  2026-09-03：类型补全 startedAt/waitingSince（运行时对象本就透传——类型窄化曾致
   *  SubagentBar 折叠行总时长拿不到起点） */
  updateSubagent(st: { id: string; description: string; activity: string; startedAt?: number; waitingSince?: number }): void {
    this.subagentView.set(st.id, st)
    this.publish('subagent/progress', { agents: [...this.subagentView.values()] })
  }

  removeSubagent(id: string): void {
    this.subagentView.delete(id)
    this.publish('subagent/progress', { agents: [...this.subagentView.values()] })
  }

  /** 审阅修复批（安全席 P1-2）：运行中子代理计数——task 工具 execute 入口的并发闸门
   *  （MAX_CONCURRENT_SUBAGENTS 对齐后台任务 MAX_CONCURRENT=8 的口径） */
  get activeSubagentCount(): number {
    return this.subagentView.size
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

  /** T 线⑥：SessionStart hook 宿主化——resume（fork 续写恢复）/startup（首会话）两路统一入口。
   *  systemMessages 转 systemMsg 帧；additionalContext 宿主暂存（startTurn 首轮注入）。
   *  fire-and-forget：hook 失败不阻塞恢复/建会话主流程（对齐原 TUI 客户端 .catch(() => {}) 语义）。 */
  private dispatchSessionStart(source: 'startup' | 'resume', sessionId: string): void {
    const deps = this.deps
    if (deps.hookRunner == null || !deps.hookRunner.hasHandlers('SessionStart')) return
    void deps.hookRunner
      .dispatch('SessionStart', { event: 'SessionStart', session_id: sessionId, source }, { cwd: this.deps.cwd })
      .then((v) => {
        for (const m of v.systemMessages) this.publish('systemMsg', { text: m })
        if (v.additionalContext.length > 0) this.pendingSessionContext.push(...v.additionalContext)
      })
      .catch(() => {})
  }

  /** B3：客户端恢复历史会话（宿主 messages 替换为载入内容；history 由调用方先行切 sessionId） */
  restoreFrom(lines: HistoryLine[]): void {
    this.messages.length = 0
    this.messages.push(...lines)
    this.mcpCallCount = 0 // 审阅 P1-1：会话切换计数归零（防旧累计值写进新会话文件致全局双计）
    this.readMtime.clear() // M13-B1：换会话已读表重置（旧会话的读取记录对新会话无意义）
    this.clearRememberedTools() // F-07 档A：换会话 remember 白名单不残留
    this.reviewTurnCount = 0 // 纠偏审查：轮计数从恢复后重数（历史轮次不参与定时兜底）
    this.pendingReviewCard = null
    // 换会话档位归零（用户拍板 2026-09-02：同项目不同对话不互相影响——档位属活动会话，
    // 切对话不带旧档；attached 冷路径/Embedded makeDeps 换新实例本就 default 幂等，同实例
    // 换会话（测试 fake 端口/降级镜像载入）在此重置）。广播帧让已连接端立即对齐归零
    this.sandboxMode = (this.cfg().sandbox?.defaultMode as SandboxMode) ?? 'default'
    this.publish('sandbox/mode', { mode: this.sandboxMode })
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
      // 手动压缩 loading（2026-09-03 用户点名）：进压缩分支即发 compacting 帧——空闲态
      // TUI ActivityBar 显示「正在压缩对话...」+实时计时（与 startTurn 装配点同款两行；
      // 此前 compactManual 缺这两行，手动压缩几十秒摘要期间 UI 全黑箱像死掉）
      onCompacting: () => this.publish('compacting', {}),
      onCompactFail: () => this.publish('compactFailed', {}),
      history: deps.history,
      tools: deps.tools.specs(),
      onUsage: (inp, out, cache) => this.recordUsage(inp, out, cache), // M12-P0：压缩漏账修复
      ...((r) => (r !== null ? { summary: r } : {}))(await this.resolveSummaryRole()), // M13-B3：摘要换笔（三项变更之②provider 替换）
    })
    try {
      // 前后数 boundary：hook 不压缩也不抛错（策略判无可压/摘要空产出），恒 {ok:true}
      // 会把「零操作」谎报成「压缩完成」——以 boundary 是否真新增为唯一事实源
      const boundariesBefore = this.messages.filter(isBoundary).length
      await hook(this.messages, 'manual')
      if (this.messages.filter(isBoundary).length > boundariesBefore) return { ok: true }
      // 零新增四条路径共用：全在保留区/配对不变量全纳入 tail/滚动摘要已涵盖无新内容/摘要空产出——
      // 归因文案中性化（审阅 P3），单列「均在保留区」对后两条误导
      return { ok: false, reason: '未执行压缩（无可压缩新内容或摘要未产出）' }
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
  private installedProgress: ((list: { id: string; description: string; activity: string; startedAt?: number; waitingSince?: number }[]) => void) | null = null

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
  // —— 任务纠偏审查（2026-09-02 用户拍板：定时兜底 + 异常信号提前触发；只审查不接管）——
  /** 用户轮计数（startTurn 自增；定时兜底按它整除触发。restoreFrom 归零——审查从恢复后重数） */
  private reviewTurnCount = 0
  /** 本轮工具批计数（afterTools 自增；startTurn 重置——长轮信号） */
  private reviewTurnIterations = 0
  /** 已完成的审查卡（轮末触发、空闲完成时暂存——下轮 startTurn 拼进 input，pendingSessionContext 同款） */
  private pendingReviewCard: string | null = null
  /** 审查单飞（轮中信号与轮末定时撞车/审查进行中再触发——只跑一次，防堆卡） */
  private reviewInflight = false
  /** 定时防重（审阅修复）：上次定时触发时的轮计数——hook block 轮计数不自增，finishTurn
   *  用旧值再判会对同一轮重复触发（连发烧钱+新卡覆盖旧卡） */
  private lastIntervalReviewedTurn = -1
  /** 信号每轮一次（审阅修复）：长失败轮批批命中阈值，无此标志会连环审查（最坏 ~38 次/
   *  轮高级模型调用）+ 卡连环注入膨胀上下文 */
  private reviewSignalFiredThisTurn = false
  private reviewerCache: { key: string; value: { provider: LLMProvider; req: ProviderReq } | null } | null = null
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

  /**
   * 审查角色解析（resolveSummaryRole 同模式）：review.enabled + provider 存在才可用；
   * 键控缓存（/model 热切换后 key 变化自动重解析）。返回 null=审查未启用/配置失效（零行为）。
   */
  private resolveReviewer(): { provider: LLMProvider; req: ProviderReq } | null {
    const cfg = this.cfg()
    const review = cfg.review
    if (review === undefined || review.enabled !== true) return null
    const key = `${review.provider}:${review.model}`
    if (this.reviewerCache?.key === key) return this.reviewerCache.value
    const providerCfg = cfg.providers[review.provider]
    // loadConfig 已校验；此处防御（运行中配置被改）——静默禁用不炸任务
    if (providerCfg === undefined) return null
    try {
      const value = {
        provider: this.deps.providerRegistry.getByType(providerCfg.type),
        req: buildProviderReqFor(cfg, review.provider, review.model),
      }
      this.reviewerCache = { key, value }
      return value
    } catch (e) {
      // 审阅修复：失败**不缓存**（原缓存 null 会让 type typo 修好后仍永久静默失效——缓存键
      // 不含 registry 状态），且不静默——用户看到 enabled=true 却无审查，应能从日志定位
      this.deps.logger.warn('review', 'resolve_failed', { provider: review.provider, message: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  /**
   * 执行一轮纠偏审查（定时兜底/信号共用；单飞防堆卡）。完成后注入（审阅修复后的分派）：
   * 快照触发时的轮身份——完成时**同一轮**仍在跑（信号止绕圈场景）→ 插话队列 midTurn
   * （kind:'review'，loop 走中性审查包装）；否则（定时常态/轮已结束或已换轮）→
   * pendingReviewCard（下轮 startTurn 拼进 input——不自动起轮烧 token，且旧任务的卡
   * 不会以插话形态错位注入用户的新任务轮）。失败静默降级，绝不打断任务主流程。
   */
  private async maybeRunReview(trigger: ReviewTrigger): Promise<void> {
    const reviewer = this.resolveReviewer()
    if (reviewer === null || this.reviewInflight) return
    const cfg = this.cfg().review
    if (cfg === undefined) return
    this.reviewInflight = true
    const reason = trigger === 'interval' ? `第 ${this.reviewTurnCount} 轮定时` : '异常信号'
    const firedTurnId = this.running ? this.currentTurnId : null // 轮身份快照（审阅修复：防跨轮错位注入）
    this.publish('systemMsg', { text: `⚡ 已请高级模型审查（${reason}，${cfg.model}）…` })
    try {
      const outcome = await callReviewer(
        reviewer.provider,
        reviewer.req,
        buildReviewMessages(this.messages.filter(isMessageLine) as Message[]),
        this.abort.signal,
      )
      if (outcome === null) {
        this.deps.logger.warn('review', 'empty_output', { trigger })
        return
      }
      // 记账：按 reviewer 模型计价（sessionCost 累计 + stats 落盘——/stats 按模型聚合可见审查成本）；
      // 不发 usage 帧不写 lastIn/lastOut（那是主轮口径，审查调用不该污染 StatusBar）
      this.recordSideUsage(cfg.model, cfg.provider, outcome.usage)
      this.deps.logger.info('review', 'card_injected', { trigger, turn: this.reviewTurnCount, chars: outcome.card.length })
      // 注入文本统一带中性前缀（审阅/安全席：不冒充用户、不带无条件服从指令——采纳建议
      // 仍须过既有确认与安全栅栏）；剥内层 [纠偏审查] 标头防双层
      const bare = outcome.card.replace(/^\[纠偏审查\]\s*\n?/, '')
      const wrapped = `[审查器附注（${cfg.model} 对近期任务轨迹的纠偏摘要，自动生成非用户消息，仅供参考）]\n${bare}`
      if (firedTurnId !== null && this.running && this.currentTurnId === firedTurnId) {
        this.queue.push({ text: wrapped, midTurn: true, kind: 'review' })
        this.publish('interjection/enqueued', { text: `纠偏卡（${reason}）已注入` })
      } else {
        this.pendingReviewCard = wrapped
        this.publish('systemMsg', { text: '✓ 纠偏卡已就绪（下一轮自动注入）' })
      }
      this.publish('queue/snapshot', { items: this.queue.map((q) => (q.kind === 'review' ? '[纠偏审查卡·待注入]' : q.text)) })
    } catch (e) {
      this.deps.logger.warn('review', 'failed', { trigger, message: e instanceof Error ? e.message : String(e) })
      this.publish('systemMsg', { text: '（纠偏审查未完成——任务不受影响）' })
    } finally {
      this.reviewInflight = false
    }
  }

  /**
   * 信号 gate（2026-09-03 拍板）：signal 审查同步化——在 afterTools 回调内 await（loop
   * await afterTools ⇒ 天然挡在下一工具批/LLM 请求之前，纠偏卡赶上下一个动作）。
   * 三路竞速：审查完成（照常分派）/ 超时 fail-open / abort 直通。
   * - 超时不取消底层审查：晚到的卡仍走既有异步路径（同轮 midTurn / 跨轮 pending），不浪费；
   *   放弃等待的 promise 挂 no-op catch（防 unhandled rejection）。
   * - interval 兜底不 gate（轮末触发本无本轮时机），维持 void 异步。
   * - reviewing 帧：gate 窗口 active true/false——TUI loading 行显示「正在纠偏审查」+计时
   *   （不黑箱）；web/旧客户端 default 无视。
   */
  private async gateSignalReview(): Promise<void> {
    const reviewCfg = this.cfg().review
    if (reviewCfg === undefined || reviewCfg.enabled !== true) return
    if (this.reviewInflight) return // 已有审查在跑（interval 跨轮窗口可达：上一轮末 void 异步发起、
    // 本轮 signal 撞上它仍在跑）——复用在跑审查不叠加等待（其结果很快到达且覆盖近期轨迹）
    if (this.resolveReviewer() === null) return // 未启用/配置失效——快速过不闪帧
    const timeoutMs = reviewCfg.timeoutMs ?? DEFAULT_REVIEW_GATE_TIMEOUT_MS
    this.publish('reviewing', { active: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const core = this.maybeRunReview('signal')
      const timeoutP = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      })
      const abortP = new Promise<'aborted'>((resolve) => {
        if (this.abort.signal.aborted) resolve('aborted')
        else this.abort.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      })
      // 内部已 catch（失败静默降级）——rejection 映射 'done' 纯防御（gate 释放语义等价，不炸 afterTools）
      const winner = await Promise.race([core.then(() => 'done' as const, () => 'done' as const), timeoutP, abortP])
      if (winner === 'timeout') {
        void core.catch(() => {}) // 底层继续跑（晚到卡照常注入）；防弃等后 unhandled rejection
        this.publish('systemMsg', { text: `（纠偏审查超时 ${Math.round(timeoutMs / 1000)}s——已继续执行，结果稍后到达）` })
      }
      // 'aborted'：轮将被中断收场，无需提示
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.publish('reviewing', { active: false })
    }
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

  /** 审阅 S3：会话归属校验——history 目录用户级跨项目共享，id 只验形态可跨项目读/改/归档
   *  他项目会话（sessionId 时间戳形态可枚举）。cwd 缺省（argv/内联形态）退化为放行（无边界可言）。
   *  低频元数据/读取命令逐次扫目录可接受（archive/rename/read/restore 均非热路径）。 */
  private ownsSession(sessionId: string): boolean {
    if (this.deps.cwd === undefined) return true
    return this.deps.history.loadAll(this.deps.cwd).some((m) => m.sessionId === sessionId)
  }

  /** 审阅 S2：路径 cwd 围栏——realpath 双判（词法 resolve 拦不住工作区内指向外部的
   *  symlink/junction；目标不存在上溯祖先链，sandbox resolveReal 同实现），大小写归一对齐 win32 */
  private isInsideCwd(abs: string): boolean {
    const base = resolve(this.deps.cwd ?? process.cwd())
    const norm = (p: string): string => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    const realTarget = resolveReal(abs)
    if (realTarget === undefined) return false
    const realBase = resolveReal(base) ?? base
    return norm(realTarget).startsWith(`${norm(realBase)}/`)
  }

  /** 清账 III P2-7：serve 端 /help 输出——只列 host 可执行五命令，面板类命令不列（web 履约不了） */
  private helpForServe(reg: import('../commands/registry.js').CommandRegistry): { output: string } {
    const hostable = new Set(['help', 'stats', 'cost', 'clear', 'compact'])
    const lines = reg
      .list()
      .filter((c) => hostable.has(c.name))
      .map((c) => `  /${c.name}  ${c.description}`)
    return { output: `${lines.join('\n')}\n（其余命令为 TUI 面板/本地命令，请在客户端使用）` }
  }

  /** F-23：斜杠命令分流。返回 undefined=非命令（正常 prompt 路径）；
   *  {ok:true,output}=host 已执行；{ok:false,error}=TUI 专属面板或未知名（明确拒绝，不进 LLM）。
   *  host 可执行白名单：/help /stats /cost /clear /compact——其余命令名的 action 均为
   *  TUI 面板/客户端本地副作用（pick-model/open-*-panel/restart…），serve 端无法履约。 */
  private async interceptSlashCommand(text: string): Promise<{ ok: true; output: string } | { ok: false; error: string } | undefined> {
    const reg = this.deps.commands
    if (reg === undefined || !text.startsWith('/')) return undefined
    const name = text.slice(1).split(/\s+/)[0] ?? ''
    // 清账 III P2-6：整条输入恰好是裸 "/"（无名字）也拦——对齐 TUI「未知命令」语义而非落 LLM
    // （普通文本含 / 不受影响：只匹配整条 === '/'）
    if (name === '' && text.trim() === '/') {
      return { ok: false, error: '未知命令 /（输入 /help 查看可用命令）' }
    }
    if (name === '') return undefined // "/ 参数"形态：非命令文本，交 prompt 路径
    const cmd = reg.get(name)
    if (cmd === undefined) {
      return { ok: false, error: `未知命令 /${name}（输入 /help 查看可用命令）` }
    }
    // host 可执行命令：纯输出或宿主已有权威操作
    if (name === 'help' || name === 'stats') {
      const args = text.slice(1 + name.length).trim()
      const r = await (name === 'help' ? this.helpForServe(reg) : cmd.run(args === '' ? undefined : args))
      return { ok: true, output: r.output ?? '' }
    }
    if (name === 'cost') {
      const u = { input: this.lastIn, output: this.lastOut, cacheRead: this.lastCacheRead, cacheCreation: this.lastCacheCreation }
      const lineCost = this.deps.costAccumulator?.() ?? this.sessionCost
      const known = lineCost > 0 || this.sessionCost > 0
      return {
        ok: true,
        output: known
          ? `本轮 token：input ${u.input} / output ${u.output} / cache_read ${u.cacheRead} / cache_creation ${u.cacheCreation}\n会话累计成本：¥${lineCost.toFixed(4)}`
          : `本轮 token：input ${u.input} / output ${u.output} / cache_read ${u.cacheRead} / cache_creation ${u.cacheCreation}\n会话累计成本：暂无（本会话尚无用量）`,
      }
    }
    if (name === 'clear') {
      this.messages.length = 0
      this.queue.length = 0
      this.editedFiles.clear()
      this.readMtime.clear()
      this.mcpCallCount = 0
      this.clearRememberedTools() // F-07 档A：会话级 remember 白名单随会话清空
      this.publish('session/clear', {}) // 清账 III P1-3：web 端视图同步（store 原是死分支——无发布者）
      this.publish('notice', { level: 'info', text: '会话已清空' })
      return { ok: true, output: '会话已清空' }
    }
    if (name === 'compact') {
      void this.compactManual().then((r) => {
        this.publish('systemMsg', { text: r.ok ? '压缩完成' : `压缩失败：${r.reason ?? '未知'}` })
      })
      return { ok: true, output: '压缩已开始（完成后有 systemMsg 通知）' }
    }
    return { ok: false, error: `/${name} 为 TUI 面板/本地命令，serve 端不可用（可用：/help /stats /cost /clear /compact；设备管理用 TUI /devices 面板或 web 设备面板）` }
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
    if (cost != null) this.sessionCost += cost // F-23：/cost 宿主累计
    this.lastIn = inputTokens
    this.lastOut = outputTokens
    this.lastCacheRead = cache?.read ?? 0
    this.lastCacheCreation = cache?.creation ?? 0
    this.publish('usage', {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cache?.read,
      cacheCreation: cache?.creation,
      costCny: cost ?? undefined,
      // F-44：上下文占用/窗口透出——占用=本轮 prompt 全量（input+cacheRead，API 真值，
      // 比本地估算准）；窗口=runLoop 装配时解析缓存的 contextWindow。StatusBar ctx 段消费
      contextUsed: inputTokens + (cache?.read ?? 0),
      contextWindow: this.ctxWindowCache,
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

  /**
   * 旁路调用记账（纠偏审查/摘要等非主轮 LLM 调用）：按**指定模型**计价，只进 sessionCost
   * 累计与 stats 落盘（/stats 按模型聚合可见），不动 lastIn/lastOut、不发 usage 帧
   * （那是主轮口径——审查调用不该污染 StatusBar 的本轮 token/上下文占用显示）
   */
  private recordSideUsage(model: string, providerName: string, usage?: { input: number; output: number; cacheRead?: number; cacheCreation?: number }): void {
    if (usage === undefined) return
    const cur = this.cfg()
    const cost = tokensToCost(model, {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheCreation: usage.cacheCreation ?? 0,
    }, cur.providers[providerName]?.pricing)
    if (cost != null) this.sessionCost += cost
    this.deps.history.appendUsageStats({
      stats: true,
      ts: Date.now(),
      cwd: this.deps.cwd ?? process.cwd(),
      model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheCreation: usage.cacheCreation ?? 0,
      costCny: cost ?? 0,
      costKnown: cost != null,
      mcpCalls: this.mcpCallCount,
    })
  }

  /**
   * 2026-09-02 用户拍板：归档是人专属操作的**唯一执行入口**（协议 dispatch 对 session/archive
   * 一律拒绝 HUMAN_ONLY_COMMAND；本方法只由 serve 层人专属端点 /api/archive 直调——
   * 手动 curl/浏览器地址栏可达，AI 会话经 /cmd 协议面永远到不了这里）。
   * 实现即原协议分支：sidecar 标记 + session/updated 帧广播（多端列表同步）+ 审计日志。
   */
  async archiveSession(sessionId: string, archived: boolean): Promise<CommandResult> {
    if (!isValidSessionId(sessionId)) return { ok: false, error: `会话 id 非法：${sessionId}`, code: 'BAD_SESSION_ID' }
    // 归属校验（审阅 S3 同口径）：跨项目改写他项目会话元数据=完整性破坏
    if (!this.ownsSession(sessionId)) return { ok: false, error: `会话不存在或不属于当前项目：${sessionId}`, code: 'SESSION_NOT_FOUND' }
    this.deps.history.patchSessionMeta(sessionId, { archived })
    this.publishUpdated(sessionId, { archived })
    this.deps.logger.info('system', 'session_archived', { sessionId, archived })
    return { ok: true }
  }

  /** session/updated 广播公共出口（审阅 A1：serve 冷路径也经此发帧——不因会话冷热分叉）。 */
  publishUpdated(sessionId: string, patch: { title?: string; archived?: boolean }): void {
    this.publish('session/updated', { sessionId, ...patch })
  }

  private async dispatch(cmd: ProtocolCommand): Promise<CommandResult> {
    switch (cmd.op) {
      case 'prompt': {
        // F-23：斜杠命令分流（serve/web 端 /help 等直通 startTurn 会当 prompt 烧 LLM）——
        // 注册了命令面时，/ 开头输入先查表：host 可执行→本地跑；TUI 专属/未知名→明确报错；
        // 绝不落入 LLM。未注册命令面（argv/旧测试）行为不变。
        const slash = await this.interceptSlashCommand(cmd.text)
        if (slash !== undefined) {
          if (slash.ok) {
            this.publish('systemMsg', { text: slash.output })
            return { ok: true, routed: 'Command' as const, output: slash.output }
          }
          this.publish('systemMsg', { text: slash.error })
          this.deps.logger.warn?.('system', 'slash_command_rejected', { text: cmd.text, reason: slash.error })
          return { ok: false, error: slash.error, code: 'SLASH_COMMAND_TUI_ONLY' }
        }
        // M14-C3③（P1-12）：同步占位先于 buildBlocks 的 await——原检查在 await 后，带图 prompt
        // 并发双发会双双通过 running 检查双开轮；startTurn 同步段清 starting（早退路径也不泄漏）
        const idle = !this.running && !this.starting
        if (idle) this.starting = true
        const blocks = cmd.images !== undefined && cmd.images.length > 0 ? await this.buildBlocks(cmd.images) : undefined
        let text = cmd.text
        if (!idle) {
          // 复查：await 窗口内轮可能已结束（入口判定过时）——此刻已空闲则直接开轮，
          // 防插话入队后滞留无人 drain（whenIdle 死等；原被双开轮 bug 遮蔽的伴生竞态）
          if (!this.running && !this.starting) {
            void this.startTurn(cmd.text, blocks, cmd.meta).catch((e: unknown) => {
              this.publish('error', { message: e instanceof Error ? e.message : String(e) })
              this.deps.logger.error('system', 'start_turn_failed', { message: e instanceof Error ? e.message : String(e) })
            })
            return { ok: true, routed: 'Started' }
          }
          if (cmd.mode === 'StartIfIdle') {
            this.queue.push({ text: cmd.text, blocks, midTurn: false })
            this.publish('queue/snapshot', { items: this.queue.map((q) => (q.kind === 'review' ? '[纠偏审查卡·待注入]' : q.text)) })
            return { ok: true, routed: 'Queued' }
          }
          if (typeof cmd.mode === 'object' && cmd.mode.Steer.expectedTurnId !== this.currentTurnId) {
            return { ok: true, routed: 'Rejected' }
          }
          // T 线⑥（D-T5a 拍板）：插话同样触发 UserPromptSubmit——本地与附着、TUI 与 web 行为一致
          // （插话注入当前轮不经过 startTurn，故入队时 dispatch；StartIfIdle 排队不在此触发——
          // 轮末兜底起轮时 startTurn 会触发，入队再触发即双计）。block=拒绝入队，context 拼进插话文本。
          if (this.deps.hookRunner != null && this.deps.hookRunner.hasHandlers('UserPromptSubmit')) {
            this.deps.logger.info('hooks', 'dispatch', { event: 'UserPromptSubmit', interjection: true })
            const verdict = await this.deps.hookRunner.dispatch('UserPromptSubmit', {
              event: 'UserPromptSubmit',
              session_id: this.deps.history.currentSessionId(),
              prompt: cmd.text,
            }, { cwd: this.deps.cwd, signal: this.abort.signal }) // 审阅修复：补 signal——中断即杀 Stop hook 子进程（原中断后 hook 照跑到自然结束，是「执行侧」最长残余段）
            if (verdict.block) {
              const msg = `✋ 插话被 hook 拦截${verdict.reason !== undefined && verdict.reason !== '' ? `：${verdict.reason}` : ''}`
              this.publish('systemMsg', { text: msg })
              return { ok: false, error: msg, code: 'HOOK_BLOCKED' }
            }
            if (verdict.additionalContext.length > 0) text = `${text}\n\n[hook context]\n${verdict.additionalContext.join('\n')}`
          }
          // StartOrSteer：busy 输入=插话（host 权威队列，D2）
          // 审阅修复（三席 P1）：中断广播后 running 仍 true（loop 后台收敛），用户此刻的
          // 新输入会被当插话入队，而中断态轮末不续投——消息滞留死轮队列须再发一条才跑。
          // 打标 afterAbort：轮末中断分支豁免续投（新任务意图，与「中断不弃中断前队列」不冲突）
          this.queue.push({ text, blocks, midTurn: true, ...(this.abort.signal.aborted ? { afterAbort: true } : {}) })
          this.publish('interjection/enqueued', { text: cmd.text })
          this.publish('queue/snapshot', { items: this.queue.map((q) => (q.kind === 'review' ? '[纠偏审查卡·待注入]' : q.text)) })
          return { ok: true, routed: 'Steered' }
        }
        void this.startTurn(cmd.text, blocks, cmd.meta).catch((e: unknown) => {
          // 不静默吞（本轮实测：fake deps 缺方法时 TypeError 被吞成无响应）
          this.publish('error', { message: e instanceof Error ? e.message : String(e) })
          this.deps.logger.error('system', 'start_turn_failed', { message: e instanceof Error ? e.message : String(e) })
        })
        return { ok: true, routed: 'Started' }
      }
      case 'interrupt': {
        // 用户拍板（2026-09-02）：Ctrl+C **立即停止任务**——三重硬化（原协作式 abort 在真机
        // 审批挂起场景不收敛：interrupt 到达 5 分钟轮不退、且日志实证双轮并行 iter 交错）：
        // ① abort 当前 controller + 全部残留活跃轮 controller（旧轮 controller 被替换后
        //    interrupt 打不到它——集合化全停）；② 立即广播停止帧（显示与执行分离：所有端
        //    秒见停，loop 在后台自行固化退出——轮真退时 finishTurn 的帧幂等无害）；
        // ③ loop 侧硬检查（迭代顶部/工具批前）+ afterTools 中断态跳过（quality/autoCommit 不跑）
        this.deps.logger.debug('system', 'interrupt_latency_probe', { stage: 'received' }) // 诊断插桩：Ctrl+C 迟滞分段计时
        // 审阅修复：空闲态（无轮在跑）不广播 aborted（误按 Ctrl+C 不制造「已中断」噪音提示）
        if (!this.running && this.activeAbortControllers.size === 0) return { ok: true }
        this.abort.abort()
        for (const c of [...this.activeAbortControllers.values()]) {
          try {
            c.abort()
          } catch {
            /* 已断幂等 */
          }
        }
        this.publish('activity', { state: 'aborted' })
        this.publish('thread/status', { busy: false, waitingOn: null, iter: 0 })
        return { ok: true }
      }
      case 'interjection/clear':
        // 审查卡是系统产物不随用户 Ctrl+U 清弃（审阅修复）——转 pendingReviewCard 随下轮携带
        {
          const reviewLeft = this.queue.filter((q) => q.kind === 'review')
          if (reviewLeft.length > 0) this.pendingReviewCard = reviewLeft[reviewLeft.length - 1].text
          this.queue.length = 0
        }
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
        this.clearRememberedTools() // F-07 档A：会话级 remember 白名单随会话清空
        this.mcpCallCount = 0 // 审阅 P1-1：与客户端 setSessionCost(0) 同语义
        // 审阅修复：/clear=换会话语义，review 状态与 restoreFrom 对齐归零（否则轮计数跨
        // 「新对话」继承——第 1 条新消息就触发定时审查；且旧对话的暂存卡会注入新对话）
        this.reviewTurnCount = 0
        this.reviewTurnIterations = 0
        this.reviewSignalFiredThisTurn = false
        this.lastIntervalReviewedTurn = -1
        this.pendingReviewCard = null
        return { ok: true }
      case 'session/restore':
        // M13-W2：restore=ensure（活复用/冷载入 restoreFrom/并发幂等单飞——落点 ProjectHost）
        if (!isValidSessionId(cmd.sessionId)) return { ok: false, error: `会话 id 非法：${cmd.sessionId}`, code: 'BAD_SESSION_ID' }
        // 审阅 S3：跨项目拉起他项目会话=在错误项目宿主里种幻影会话——归属校验
        if (!this.ownsSession(cmd.sessionId)) return { ok: false, error: `会话不存在或不属于当前项目：${cmd.sessionId}`, code: 'SESSION_NOT_FOUND' }
        if (this.deps.ensureConversation === undefined) {
          return { ok: false, error: '命令 session/restore 尚未接线（无 ProjectHost）', code: 'NOT_IMPLEMENTED' }
        }
        {
          const r = await this.deps.ensureConversation(cmd.sessionId)
          if (!r.ok || cmd.fork !== true) return r
          // T 线②（D 拍板 2026-08-31）：fork 续写宿主化——原 TuiApp restoreSession 的手搓三步
          // （起新 id 播种/快照目录跟随/SessionStart(resume)）移入宿主，附着与本地两形态行为一致。
          // 回执 value 覆盖为新 sessionId（客户端以新 id 为当前会话续写）。
          const messages = [...this.transcript]
          if (messages.length === 0) {
            return { ok: false, error: '恢复失败：该会话为空或已损坏（文件缺失/无消息），未切换', code: 'EMPTY_SESSION' }
          }
          const newId = new Date().toISOString().replace(/[:.]/g, '-')
          this.deps.history.forkSession(newId, messages, this.cfg().current.model)
          await this.deps.checkpoint
            ?.copyForResume(cmd.sessionId, newId)
            .catch((e: unknown) =>
              this.publish('notice', { level: 'warn', text: `快照跟随失败（恢复会话后旧快照不可用）：${e instanceof Error ? e.message : String(e)}` }),
            )
          void this.dispatchSessionStart('resume', newId)
          return { ok: true, value: { sessionId: newId } }
        }
      case 'session/list': {
        // M13-W4 冷热合并：历史 meta（冷）∪ 活会话 running 态（热）——前端一份列表两端状态。
        // cwd 过滤（审阅 P0-3②）：history 目录用户级全局，无过滤会把本机所有项目的会话
        // 全量返回给任一项目（web 端又无条件标注 selectedProject，跨项目会话混列）
        // 批 2：默认过滤归档会话（web「已归档」入口带 includeArchived 拉全量）
        const states = this.deps.conversationStates?.()
        let metas = this.deps.history.loadAll(this.deps.cwd)
        if (cmd.includeArchived !== true) metas = metas.filter((m) => m.archived !== true)
        if (states === undefined) return { ok: true, value: metas }
        return { ok: true, value: metas.map((m) => (states.has(m.sessionId) ? { ...m, running: states.get(m.sessionId) } : m)) }
      }
      // 2026-09-02 用户拍板：**归档是人专属操作，AI/协议通道不可发起**（不存在"审批后放行"）。
      // 事故依据：full-access 会话用 curl 调 serve API 静默归档了用户正聊着的会话——协议命令
      // 不区分人与 AI，AI 读到 token 即可冒充人。故协议 dispatch 一律拒绝（HUMAN_ONLY_COMMAND）；
      // 唯一执行入口 = serve 层人专属端点（multi.ts /api/archive）经宿主 archiveSession() 直调。
      // TUI 同样无归档入口（/history 面板不含该操作）。
      case 'session/archive':
        return { ok: false, error: '归档是人专属操作，不能由 AI/协议通道发起（web 归档按钮走人专属端点）', code: 'HUMAN_ONLY_COMMAND' }
      case 'session/rename': {
        // 批 2：手动重命名（pin 语义——覆盖 firstUser 显示）；同帧广播多端同步
        if (!isValidSessionId(cmd.sessionId)) return { ok: false, error: `会话 id 非法：${cmd.sessionId}`, code: 'BAD_SESSION_ID' }
        // 审阅 S3：同 archive——归属校验（跨项目改标题）
        if (!this.ownsSession(cmd.sessionId)) return { ok: false, error: `会话不存在或不属于当前项目：${cmd.sessionId}`, code: 'SESSION_NOT_FOUND' }
        // 审阅 S-P2：标题剥控制字符/ESC 序列（裸 ESC 剥掉后残文无害化）再入 sidecar 与广播
        const title = cmd.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
        if (title === '') return { ok: false, error: '标题不能为空', code: 'BAD_TITLE' }
        this.deps.history.patchSessionMeta(cmd.sessionId, { title })
        this.publish('session/updated', { sessionId: cmd.sessionId, title })
        this.deps.logger.info('system', 'session_renamed', { sessionId: cmd.sessionId })
        return { ok: true }
      }
      case 'session/read':
        // M14-C1①a：分页带宽选项——fromLine/limit 是 **transcript 行索引**语义（原 beforeSeq 名义
        // 事件 seq，但 transcript 行与事件 seq 是两个 ID 空间，改名澄清）。缺省全量（web 断线
        // 全量补拉维持 M13-Q10 非目标不变）；带参返回 { lines, total, fromLine } 形态
        {
          // 审阅 P0-1：sessionId 进文件路径，白名单校验（黑名单必漏形态）
          if (!isValidSessionId(cmd.sessionId)) return { ok: false, error: `会话 id 非法：${cmd.sessionId}`, code: 'BAD_SESSION_ID' }
          // 审阅 S3（范围外并入）：跨项目读他项目会话全文=机密性缺口，比 archive/rename 更重——同守卫
          if (!this.ownsSession(cmd.sessionId)) return { ok: false, error: `会话不存在或不属于当前项目：${cmd.sessionId}`, code: 'SESSION_NOT_FOUND' }
          const all = this.deps.history.restoreFull(cmd.sessionId)
          if (cmd.fromLine === undefined && cmd.limit === undefined) return { ok: true, value: all }
          const from = Math.max(0, Math.floor(cmd.fromLine ?? 0))
          const limit = Math.max(1, Math.floor(cmd.limit ?? 200))
          return { ok: true, value: { lines: all.slice(from, from + limit), total: all.length, fromLine: from } }
        }
      case 'item/read': {
        // M14-C1⑤：工具全文按需读取（帧内 4KB 截断的补全通道）。三源查询：
        // ①截断全文暂存（确定性命中刚完成的截断工具——messages 追加前 TUI 的补全请求就到，
        // 并行轮慢兄弟拖落盘的窗口 2026-08-29 dogfood 实测踩空）；②内存 mirror；③盘上原文
        // （投影派压缩不删消息，restoreFull 保留 tool_result 全量——内存丢原文的场景盘上仍可得）
        const ringHit = this.recentFullResults.get(cmd.itemId)
        const target: { content: unknown } | null =
          ringHit !== undefined
            ? { content: ringHit }
            : (this.findToolResult(this.messages, cmd.itemId)
              ?? this.findToolResult(this.deps.history.restoreFull(this.deps.history.currentSessionId()), cmd.itemId))
        if (target === null) {
          return { ok: false, error: `工具结果 ${cmd.itemId} 不存在或未落盘`, code: 'ITEM_NOT_FOUND' }
        }
        const content = typeof target.content === 'string' ? target.content : JSON.stringify(target.content)
        if (content.length > ITEM_READ_CAP) {
          return { ok: true, value: { content: content.slice(0, ITEM_READ_CAP), truncated: true } }
        }
        return { ok: true, value: { content } }
      }
      case 'model/set': {
        // 切模型（web 顶栏/附着态 TUI/协议面；2026-09-03 起 TUI /model 也发本帧——旧「TUI
        // 走客户端本地 setConfig 不经此」的注释随假切换根治退役：setConfig 只改 TUI state，
        // 宿主 cfg 由本 handler 就地改才是两形态（embedded/附着）共同的真同步面）。
        // getConfig 是活引用——改 current 后下一轮 provider/getProvider/ctxWindow 即取新值；
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
      case 'session/compact':
        // T1：压缩链宿主权威触发（与 interceptSlashCommand 的 /compact 同路径复用——
        // 附着态 TUI/web 都经此命令；busy 语义与 /compact 一致：压缩链自带守卫）
        void this.compactManual().then((r) => {
          this.publish('systemMsg', { text: r.ok ? '压缩完成' : `压缩失败：${r.reason ?? '未知'}` })
        })
        return { ok: true, output: '压缩已开始（完成后有 systemMsg 通知）' }
      case 'rewind/list': {
        // T1：快照列表 + 外部修改宿主预计算（契约 RewindListResult——客户端免二次往返；
        // 旧 TUI 直调 CheckpointStore.list/detectExternalChanges 的双调用在协议面合一）
        const cp = this.deps.checkpoint
        if (cp == null) return { ok: false, error: 'checkpoint 未装配', code: 'NOT_IMPLEMENTED' }
        const sid = this.deps.history.currentSessionId()
        const metas = await cp.list(sid)
        const snapshots = []
        for (const m of metas) {
          const externallyChanged = await cp.detectExternalChanges(sid, m.seq).catch(() => [] as string[])
          snapshots.push({ ...m, externallyChanged })
        }
        return { ok: true, value: { sessionId: sid, snapshots } satisfies RewindListResult }
      }
      case 'rewind/exec': {
        // T1：回退执行宿主权威化——文件还原 + transcript 镜像留痕 + history 落盘（原 TuiApp onDone
        // 手搓三步全数移入）；busy 守卫拒绝运行中执行；rewind/applied 帧驱动客户端 session/read 重拉
        const cp = this.deps.checkpoint
        if (cp == null) return { ok: false, error: 'checkpoint 未装配', code: 'NOT_IMPLEMENTED' }
        if (this.isBusy) return { ok: false, error: '轮运行中不可回退，请先中断', code: 'BUSY' }
        const sid = this.deps.history.currentSessionId()
        const r = await cp.revert(sid, cmd.target)
        const meta = (await cp.list(sid)).find((m) => m.seq === cmd.target)
        const line: RewindLine = {
          rewind: true,
          seq: cmd.target,
          ...(meta?.messageId !== undefined ? { toolUseId: meta.messageId } : {}),
          time: new Date().toISOString(),
        }
        this.appendRewind(line)
        this.deps.history.appendRewind(line)
        this.publish('rewind/applied', {
          seq: cmd.target,
          ...(line.toolUseId !== undefined ? { toolUseId: line.toolUseId } : {}),
          time: line.time,
        })
        return { ok: true, value: { restored: r.restored, externalChanged: r.externalChanged } satisfies RewindExecResult }
      }
      case 'panel/data': {
        // T1：面板读面（View 契约冻结 protocol/types；plugin 挂账 D-T2，doctor 非面板）
        // 2026-09-03：tasks 分支不经 deps.panelData——任务快照是 this.tasks（ToolContext 同源
        // registry）直读，attach 态客户端进程单例查不到 daemon 侧任务（Ctrl+T 详情/TasksBar 数据源）
        if (cmd.panel === 'tasks') return { ok: true, value: this.tasks.snapshot() }
        const pd = this.deps.panelData
        if (pd === undefined) return { ok: false, error: '面板数据未装配', code: 'NOT_IMPLEMENTED' }
        // 审阅修复批（架构席 P1-1）：default 错误分支——原 skill/mcp 二分对未知 panel 值
        // fallback 执行 mcp()，版本 skew（新客户端打旧 daemon 发新 panel 名）时返回错误 shape
        // 炸客户端渲染树；显式拒绝并给出可判别 code
        if (cmd.panel === 'skill') return { ok: true, value: await pd.skill() }
        if (cmd.panel === 'mcp') return { ok: true, value: await pd.mcp() }
        return { ok: false, error: `未知面板：${String(cmd.panel)}`, code: 'BAD_PANEL' }
      }
      case 'mcp/action': {
        // T1：MCP 面板写动作（reconnect/close 单 server）
        const pd = this.deps.panelData
        if (pd?.mcpAction === undefined) return { ok: false, error: 'MCP 动作未装配', code: 'NOT_IMPLEMENTED' }
        const r = await pd.mcpAction(cmd.action, cmd.server)
        return r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error ?? `${cmd.action} 失败`, code: 'MCP_ACTION_FAILED' }
      }
      case 'mcp/approve': {
        // T1：项目 .mcp.json 首用批准门过协议（附着态 MCP manager 在 daemon——原 TuiApp overlay
        // 直调 approve() 的同进程捷径退役）。拒绝=不注册（setup 已按未批准处理），仅审计留痕。
        const pa = this.deps.panelData?.approveMcp
        if (pa === undefined) return { ok: false, error: 'MCP 批准门未装配', code: 'NOT_IMPLEMENTED' }
        await pa(cmd.file, cmd.approved)
        this.deps.logger.info('mcp', 'approve_gate', { file: cmd.file, approved: cmd.approved })
        this.publish('systemMsg', { text: cmd.approved ? '已批准项目 .mcp.json（工具已接入）' : '已拒绝项目 .mcp.json' })
        return { ok: true }
      }
      case 'sandbox/set':
        // F-33（用户拍板，翻案清账 III P1-2 的 BUSY 拒绝）：运行中 Tab 切档立即生效——
        // 口径统一靠 getter 化（toolCtx.checkWrite 经 session.getSandbox 读实时档，
        // hostConfirm 读实时 this.sandboxMode），轮初快照时滞不再存在，BUSY 守卫随之废除
        // 提权门槛（v1.2 P1-4）：提档 full-access 需经审批（有订阅者）；降档直接生效
        if (cmd.mode === 'full-access' && cmd.mode !== this.sandboxMode) {
          if (this.channel.subscriberCount === 0) {
            return { ok: false, error: '提档 full-access 需要客户端确认（当前无订阅者）', code: 'NEED_CLIENT' }
          }
          // 审阅修复批（2026-08-31 四角色）：提档卡入串行队列+接当轮 signal（D9 残余路径闭合）
          const ok = await this.enqueueConfirm(() =>
            this.broker.confirm(
              { type: 'tool_use', id: `sandbox-set-${Date.now()}`, name: 'sandbox/set', input: { mode: cmd.mode } },
              `沙箱提档 → full-access（确认后本会话副作用工具免确认）`,
              false,
              this.abort.signal,
            ),
          )
          if (!ok) return { ok: false, error: '用户拒绝提档', code: 'REJECTED' }
        }
        this.sandboxMode = cmd.mode
        // 会话级档位广播：同对话多端（TUI/web）显示即时对齐（channel 会话私有+mux 信封
        // sessionId——同项目他对话端收不到；本端切档回声 applySandboxMode 幂等）
        this.publish('sandbox/mode', { mode: this.sandboxMode })
        return { ok: true }
      case 'sandbox/get':
        // 档位回传（重连失同步修复）：宿主真档唯一权威源——客户端附着/重连时点拉取对齐显示
        return { ok: true, value: { mode: this.sandboxMode } }
      default:
        // B5（命令·会话·面板族）逐批接线
        return { ok: false, error: `命令 ${cmd.op} 尚未接线（B5 批次）`, code: 'NOT_IMPLEMENTED' }
    }
  }

  /** F-34：在 HistoryLine 集合里按 tool_use_id 找配对 tool_result（item/read 内存/盘双源共用） */
  private findToolResult(lines: readonly HistoryLine[], itemId: string): { content: unknown } | null {
    for (const l of lines) {
      if (!isMessageLine(l) || l.role !== 'user' || typeof l.content === 'string') continue
      for (const b of l.content) {
        if (b.type === 'tool_result' && b.tool_use_id === itemId) return b
      }
    }
    return null
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

  private async startTurn(input: string, blocks?: ImageBlock[], entryMeta?: MessageMeta): Promise<void> {
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
    const turnId = this.currentTurnId
    this.abort = new AbortController()
    // 用户拍板（2026-09-02 Ctrl+C 立即停）：活跃轮 controller 按轮登记（finishTurn 按轮注销）——
    // interrupt 全集 abort 兜底双轮并行残留（真机日志：iter 交错=旧轮 controller 被替换后
    // interrupt 打不到它；集合化保证一次 Ctrl+C 停掉本会话所有在跑的轮）
    this.activeAbortControllers.set(turnId, this.abort)
    // 2026-09-03 归属根治 P2-2：hook additionalContext 收集器（UserPromptSubmit 即时 + SessionStart
    // 暂存两源合并）——不再拼进 input，统一走 preInjected（meta:system-notice 独立系统行）
    const hookCtxFromPrompt: string[] = []
    // UserPromptSubmit hook（session_id 用真实会话 id——顺手修 TuiApp 侧硬编码 '' 的同源问题）
    if (deps.hookRunner != null && deps.hookRunner.hasHandlers('UserPromptSubmit')) {
      this.deps.logger.info('hooks', 'dispatch', { event: 'UserPromptSubmit' })
      const verdict = await deps.hookRunner.dispatch('UserPromptSubmit', {
        event: 'UserPromptSubmit',
        session_id: deps.history.currentSessionId(),
        prompt: input,
      }, { signal: this.abort.signal, cwd: this.deps.cwd })
      if (verdict.block) {
        this.publish('systemMsg', { text: `✋ 输入被 hook 拦截${verdict.reason !== undefined && verdict.reason !== '' ? `：${verdict.reason}` : ''}` })
        this.finishTurn(turnId)
        return
      }
      if (verdict.additionalContext.length > 0) hookCtxFromPrompt.push(...verdict.additionalContext)
    }
    // T 线⑥：SessionStart 产出的 additionalContext 宿主暂存，拼进恢复/新建后首轮输入
    // （原 TUI pendingSessionCtxRef 客户端机制的宿主等价物——附着态 web/TUI 同样生效；
    // 前缀与 UserPromptSubmit 同款 [hook context]——同源 hook 产物，模型视角一致）
    // 2026-09-03 归属根治 P2-2：hook context 不再拼进 input——收集进 preInjected（meta:system-notice，
    // 独立系统行呈现，不冒充用户气泡；[hook context] 前缀保留——模型侧来源标注不变）
    const hookCtxFromSession = this.pendingSessionContext
    this.pendingSessionContext = []
    // 09-03 走查：前缀由下方统一包装（原此处预加一次=模型侧双重 [hook context] 前缀）
    for (const c of hookCtxFromSession) hookCtxFromPrompt.push(c)
    // 纠偏审查（2026-09-02）：空闲期完成的审查卡随本轮注入（同 additionalContext 模式——
    // 不自动起轮烧 token，用户下一条消息自然携带）。卡文本自带中性前缀（审阅/安全席修复：
    // 去「请按建议校正」服从指令——采纳建议仍须过既有确认与安全栅栏）
    // 2026-09-03 归属根治：通知/审查卡不再拼进 input 字符串——收集为预注入消息（带 meta 的
    // 独立 user 消息，runLoop 的 userInput 去重检测会看到顶部已是 user 消息而跳过重复 push，
    // 预注入消息作为独立气泡/系统行留在 transcript）。用户气泡只含用户文本。
    const preInjected: Message[] = []
    for (const n of this.tasks.collectNotifications()) {
      preInjected.push({ role: 'user', content: [{ type: 'text', text: n.text }], meta: n.meta })
    }
    for (const c of hookCtxFromPrompt) {
      preInjected.push({ role: 'user', content: [{ type: 'text', text: `[hook context]\n${c}` }], meta: { kind: 'system-notice' } })
    }
    if (this.pendingReviewCard !== null) {
      preInjected.push({ role: 'user', content: [{ type: 'text', text: this.pendingReviewCard }], meta: { kind: 'review-card' } })
      this.pendingReviewCard = null
    }
    // 预注入消息先落 transcript 再进 runLoop（2026-09-03 归属根治）：用户输入照常追加在其后，
    // runLoop 顶部 userInput 去重检测只对比最后一条消息（=用户输入本身），无双写
    for (const pre of preInjected) {
      this.messages.push(pre)
      deps.history.append(pre)
    }
    this.reviewTurnCount += 1
    this.reviewTurnIterations = 0
    this.reviewSignalFiredThisTurn = false

    // 2026-09-03 归属根治 P2-3：预注入机器消息发 systemMsg 帧（web 实时流可见——消除「TUI 看得到
    // 通知而 web 看不到」的信息不对称）；turn/started 带 userInput+meta 供 web 分流用户气泡/系统行
    for (const pre of preInjected) {
      this.publish('systemMsg', { text: (pre.meta?.kind === 'review-card' ? '◎ ' : '') + (pre.content[0] as { text: string }).text })
    }
    this.publish('turn/started', { turnId, userInput: input, ...(entryMeta !== undefined ? { userInputMeta: entryMeta } : {}) })
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
      const hostSelf = this
      await runLoop(this.messages, input, {
        provider,
        tools: deps.tools,
        logger: deps.logger,
        history: deps.history,
        callbacks: {
          onText: (t) => this.publish('delta', { turnId, text: t }),
          // 活动流 B2（itemId 同源修复，v1.7 §4）：item/started.itemId = 真实 tool_use id——
          // 旧合成 id（`${turnId}-${++itemSeq}`）与 completed 的真实 id 永不相交，web 按 id 回填恒失败
          onToolStart: (name, id) => this.publish('item/started', { turnId, itemId: id, name }),
          // 思考链路（B1 回调 → 协议帧；blockIndex 供客户端按块配对）
          onThinking: (blockIndex, text) => {
            if (!this.thinkingStarts.has(blockIndex)) this.thinkingStarts.set(blockIndex, Date.now())
            this.thinkingBufs.set(blockIndex, (this.thinkingBufs.get(blockIndex) ?? '') + text)
            this.publish('thinking', { turnId, blockIndex, text })
          },
          onThinkingEnd: (blockIndex) => {
            const started = this.thinkingStarts.get(blockIndex)
            const durMs = started === undefined ? 0 : Date.now() - started
            this.thinkingStarts.delete(blockIndex)
            this.publish('thinking/ended', { turnId, blockIndex, durMs })
            // D4-B：ThinkingLine 双写（内存镜像 + 落盘——appendRewind 先例；只写一处则
            // session/read 与 pullTranscript 两源分叉）
            const line: ThinkingLine = { thinking: true, text: this.thinkingBufs.get(blockIndex) ?? '', durMs, time: new Date().toISOString() }
            this.thinkingBufs.delete(blockIndex)
            this.messages.push(line)
            deps.history.appendThinking(line)
          },
          // D9（v1.7 双帧定稿）：执行开始（confirm 后）→ item/executing 带 digest（宿主生成单源
          // makeToolDigest——净化+60 列截断内建；loading 行「正在执行 <命令>」的数据前提）
          onToolExecute: (name, id, input) => this.publish('item/executing', { turnId, itemId: id, digest: makeToolDigest(name, input) }),
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
            // M13-P1 结果感知：签名升级为 name+input+resultHead——参数同且结果同才算空转；
            // 结果变=有新信息=签名变=清零重计（观测轮询不再被误杀，零产出等待仍受保护）
            if (use !== undefined && use.type === 'tool_use') this.roundUses.push(`${use.name}:${JSON.stringify(use.input)}:${r.content.slice(0, 200)}`)
            // M14-C1⑤ 工具全文 summary+read 分野：帧内 content 截断 4KB（mux 全文出帧=LAN 旁听面，
            // MB 级输出也拖累每连接带宽）；全文走 item/read 按需（transcript 权威源）
            const full = r.content as string
            const truncated = full.length > ITEM_FRAME_CAP
            // 截断全文进暂存环形缓冲（插入序淘汰）——item/read 的确定性第二源，见 RECENT_FULL_RING 注
            if (truncated && full.length <= RECENT_FULL_CAP) {
              this.recentFullResults.set(id, full)
              while (this.recentFullResults.size > RECENT_FULL_RING) {
                const oldest = this.recentFullResults.keys().next().value
                if (oldest === undefined) break
                this.recentFullResults.delete(oldest)
              }
            }
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
          // error 级走 notice 常驻通道（TUI error 不自动过期；warn 帧是 12s 过期旧通道）——
          // max_tokens 续写耗尽等「必须用户行动」的警告用（2026-08-30 对标批；曾随并行提交丢失重补）
          onError: (m) => this.publish('notice', { level: 'error', text: m }),
        },
        providerReq,
        system,
        maxIterations: this.cfg().maxIterations,
        toolCtx: {
          cwd,
          // F-39：bash 输出截断阈值接通 config（此前 config 字段定义零消费悬空）
          maxOutputBytes: this.cfg().bashMaxOutputBytes,
          session: {
            tasks: this.tasks,
            updateSubagent: (st) => this.updateSubagent(st),
            removeSubagent: (id) => this.removeSubagent(id),
            // 审阅修复批：并发闸门计数（宿主 subagentView 权威——多会话不串台）
            getActiveSubagentCount: () => this.activeSubagentCount,
            confirmTool: (use) => this.hostConfirm(use, this.abort.signal),
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
              if (tool === 'bash' || tool === 'bash-background') await this.bashCapturePre()
              await this.deps.checkpoint?.snapshot(this.deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
            },
            onAfterBash: () => this.bashAmendAbsent(),
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
            if (tool === 'bash' || tool === 'bash-background') await this.bashCapturePre()
            await deps.checkpoint?.snapshot(deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
          },
          onAfterBash: () => this.bashAmendAbsent(),
          model: this.cfg().current.model,
          // F-33：轮初快照改访问器属性——运行中 Tab 切档立即生效（工具侧每次 ctx.sandbox
          // 读取都实时 makeSandbox，与 hostConfirm 读 this.sandboxMode 同源无口径分裂；
          // getter 内 this 指字面量自身，须外部捕获 hostSelf；argv 装配不受影响）
          get sandbox() {
            return makeSandbox(hostSelf.sandboxMode, cwd, hostSelf.cfg().sandbox?.blockedCommands ?? [])
          },
        },
        onBeforeRequest,
        onCompacted: () => this.publish('compacted', {}),
        // B2：审批经 Broker（doConfirm 的 full-access 跳过/read-only MCP 拒绝/预览生成在宿主侧策略）
        // D9：signal 透传——中断即收敛挂起卡（审批不再拖住 Ctrl+C）
        confirm: (use) => this.hostConfirm(use, this.abort.signal),
        onSensitiveAccess: (description: string) => this.enqueueConfirm(() => this.broker.sensitive('read_file', description, this.abort.signal)),
        ...(blocks !== undefined ? { userBlocks: blocks } : {}),
        // 2026-09-03 归属根治 P2-1：queue 条目 meta 透传（机器条目起轮时消息带标记；缺省 undefined=用户消息）
        ...(entryMeta !== undefined ? { userMeta: entryMeta } : {}),
        afterTools: this.makeAfterTools(),
        signal: this.abort.signal,
        pollUserInput: () => {
          // 步间注入只吃插话语义（midTurn）且无图的条目；排队语义（StartIfIdle）与带图条目
          // 留给轮末兜底（带图以 blocks 起轮，见类头偏差记录）。
          // 审查卡（kind:'review'）带标记返回——loop 据此走中性审查包装（不冒充用户，审阅修复）
          const injectable = this.queue.filter((q) => q.midTurn && q.blocks === undefined)
          if (injectable.length === 0) return null
          for (const q of injectable) {
            this.queue.splice(this.queue.indexOf(q), 1)
            this.publish('interjection/injected', { text: q.kind === 'review' ? '纠偏审查卡' : q.text })
          }
          this.publish('queue/snapshot', { items: this.queue.map((q) => (q.kind === 'review' ? '[纠偏审查卡·待注入]' : q.text)) })
          // 单条 review：带 kind 标记；多条混合/多条用户：合并文本（既有行为）
          if (injectable.length === 1 && injectable[0].kind === 'review') {
            return { text: injectable[0].text, kind: 'review' as const }
          }
          return injectable.map((q) => q.text).join('\n\n')
        },
      })
    } catch (e) {
      this.publish('error', { message: e instanceof Error ? e.message : String(e) })
    } finally {
      // Stop hook（对齐 TUI 语义；argv 经宿主后也获得——行为增强，记录在案）
      try {
        if (deps.hookRunner != null && deps.hookRunner.hasHandlers('Stop')) {
          await deps.hookRunner.dispatch('Stop', { /* 审阅修复：补 signal——中断后 Stop hook 子进程不再拖住轮收尾（UserPromptSubmit 同款） */
            event: 'Stop',
            session_id: deps.history.currentSessionId(),
            stop_reason: this.abort.signal.aborted ? 'aborted' : 'turn-complete',
          }, { cwd: this.deps.cwd })
        }
      } catch {
        // Stop hook 失败不掩盖主结果（与 TuiApp 同款 fail-open 语义）
      }
      this.finishTurn(turnId)
    }
  }

  /** B2 宿主侧确认策略（doConfirm 语义迁入：full-access 跳过 / read-only MCP 拒绝 / 其余过 Broker）。
   *  界面批 C1 accept-edits：纯编辑类（edit_file/write_file）免审批直放——CC acceptEdits 对位；
   *  sensitivePath 硬门例外：编辑 .ecode/settings* 等敏感路径仍照卡（安全敏感操作不随档位降级） */
  /** D9 修复（2026-08-31 走查）：审批卡串行队列——并行只读批次里多张 sensitive 卡同时挂起时，
   *  TUI 审批卡是单槽（后帧顶掉前帧且不再渲染），未应答挂起悬空至审批超时（默认 900s），
   *  表现为「整轮假死」。宿主级串行化：同一时刻至多一张卡在桌面上（M11 子代理桥 confirm
   *  串行队列同款先例）；中断的排队项经 aborted 快拒不落卡。 */
  private confirmChain: Promise<unknown> = Promise.resolve()
  private enqueueConfirm<T>(task: () => Promise<T>): Promise<T> {
    // 链尾吞错重赋值保证 confirmChain 恒 fulfilled——前序 task 抛错不阻断后续（调用方仍拿到原 rejection）
    const run = this.confirmChain.then(task)
    this.confirmChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async hostConfirm(use: import('../core/types.js').ToolUseBlock, signal?: AbortSignal): Promise<boolean | string> {
    if (this.sandboxMode === 'full-access') return true
    // F-07 档A：会话级 remember 白名单命中直放（a 键放行过 edit/write）。sensitive 硬门
    // 前置再比对（双保险：敏感卡当时无第三键不可能入集合，此处再挡一次路径判定）
    const target = typeof (use.input as { path?: unknown }).path === 'string' ? (use.input as { path: string }).path : ''
    if (this.broker.rememberedTools.size > 0 && REMEMBER_TOOLS.has(use.name)) {
      const abs = target === '' ? null : resolve(this.deps.cwd ?? process.cwd(), target)
      // 审阅 S2：remember 直放加 cwd 围栏（realpath 双判，workspace-write 同口径）——
      // 按过一次 a 键不应对任意路径免确认；越界/无法解析真实路径回落 Broker 照卡（fail-closed）
      if (abs !== null && !isSensitivePath(abs) && !isProjectEcodeSettings(abs) && this.isInsideCwd(abs)) return true
    }
    if (this.sandboxMode === 'accept-edits' && (use.name === 'edit_file' || use.name === 'write_file')) {
      // 清账 III P2-2：非法输入不属可放行类——path 非法（缺/非字符串）照卡（fail-closed 反转）
      const abs = target === '' ? null : resolve(this.deps.cwd ?? process.cwd(), target)
      // 清账 III P0-1：项目级 .ecode/settings*（权限规则文件——hook 自授权链）照卡，
      // isSensitivePath 的 .ecode 围栏只挂 homedir 下（session.ts 不全局改，避免误伤）
      if (abs === null || (!isSensitivePath(abs) && !isProjectEcodeSettings(abs))) {
        return abs !== null // 正常路径直放；path 非法 fallthrough 走 Broker 照卡
      }
      // 敏感路径编辑照卡（走 Broker 弹窗——文案由 buildPreview 生成）
    }
    if (this.sandboxMode === 'read-only' && use.name.startsWith('mcp__')) {
      this.publish('systemMsg', { text: `read-only 模式：MCP 工具 ${use.name} 被拒绝` })
      return false
    }
    const preview = await buildPreview(use, this.deps.cwd ?? process.cwd()).catch(
      (e: unknown) => `⚠ 无法生成预览：${e instanceof Error ? e.message : String(e)}`,
    )
    // F-07 档A：edit/write 且目标非敏感路径 → 卡带 always 第三键（「本会话记住此工具」）
    let canAlways = false
    if (REMEMBER_TOOLS.has(use.name)) {
      const abs = target === '' ? null : resolve(this.deps.cwd ?? process.cwd(), target)
      canAlways = abs !== null && !isSensitivePath(abs) && !isProjectEcodeSettings(abs)
    }
    if (signal?.aborted === true) return false // 中断后排队的确认不再落卡（fail-closed）
    return this.enqueueConfirm(() => this.broker.confirm(use, preview, canAlways, signal))
  }

  private finishTurn(turnId: string): void {
    // 活动流审阅 R1/P1-1：思考块计时/累积的轮边界清理——中断轮（abort/断流）thinking_end
    // 不触发，残留会把上一轮半截思考拼进下一轮且 durMs 虚高（blockIndex 复用从 0 起）
    this.thinkingStarts.clear()
    this.thinkingBufs.clear()
    this.deps.logger.debug('system', 'interrupt_latency_probe', { stage: 'turn_finished' }) // 诊断插桩
    if (!this.turnHadTools) this.loopGuardTextTurn() // M13-B2：纯文本轮复读（onWarn 通道）
    this.publish('turn/completed', { turnId })
    this.publish('thread/status', { busy: false, waitingOn: null, iter: 0 })
    this.running = false
    this.currentTurnId = null
    this.activeAbortControllers.delete(turnId) // 审阅修复：按轮注销（原 delete(this.abort) 删的是当前字段——双轮形态下旧轮收尾误删新轮的登记、自己的 controller 永久残留）
    // 纠偏审查·定时兜底（2026-09-02 用户拍板）：轮计数整除命中才触发（默认第 5/10/15…轮末）。
    // 异步 void 不阻塞队列续投——完成时按轮身份快照分派（同轮插话/否则 pending）。
    // lastIntervalReviewedTurn 防重（审阅修复）：hook block 轮计数不自增，旧值再判会重复触发
    if (
      this.cfg().review?.enabled === true &&
      !this.abort.signal.aborted &&
      this.reviewTurnCount !== this.lastIntervalReviewedTurn &&
      shouldReviewAtTurnEnd(this.reviewTurnCount, this.cfg().review ?? {})
    ) {
      this.lastIntervalReviewedTurn = this.reviewTurnCount
      void this.maybeRunReview('interval')
    }
    // 轮末兜底：队列续投（带图条目在此以 blocks 起轮）。
    // 中断态不续投（Ctrl+C「无法中断」根因：断掉当前轮后这里立刻用队列条目起新轮，
    // 看似模型停不下来）；队列保留（CC 同款中断不弃队列——下一轮 pollUserInput 步间注入或用户再提交时消费）
    // 审查卡（kind:'review'）不参与续投（审阅修复）：自动起轮消化系统卡=无人输入下烧主模型
    // 调用，违背 pending 分支「不自动起轮」承诺——转 pendingReviewCard 随下轮携带
    // 审阅修复：中断态不续投的是**中断前**的旧插话（CC 同款语义）；中断后到达的新输入
    // （afterAbort 打标）= 用户看到停止反馈后的新任务意图——照常续投起轮
    let next = this.abort.signal.aborted
      ? (() => {
          const idx = this.queue.findIndex((q) => q.afterAbort === true)
          if (idx < 0) return undefined
          const [entry] = this.queue.splice(idx, 1)
          return entry
        })()
      : this.queue.shift()
    while (next !== undefined && next.kind === 'review') {
      this.pendingReviewCard = next.text
      next = this.queue.shift()
    }
    const keptCount = this.queue.filter((q) => q.afterAbort !== true).length
    if (this.abort.signal.aborted && keptCount > 0) {
      this.publish('systemMsg', { text: `已中断（插话队列保留 ${keptCount} 条，下轮自动注入；Ctrl+U 清空）` })
    }
    if (next !== undefined) {
      this.publish('queue/snapshot', { items: this.queue.map((q) => (q.kind === 'review' ? '[纠偏审查卡·待注入]' : q.text)) })
      void this.startTurn(next.text, next.blocks, next.meta).catch((e: unknown) => {
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
      // 2026-09-03 归属根治：feedback 与来源 meta 成对携带（结构化，替代此前裸 string + UI 前缀匹配）
      let feedback: string | undefined
      let feedbackMeta: MessageMeta | undefined
      // Ctrl+C 立即停（用户拍板 2026-09-02）：中断态跳过整段轮末链（quality lint/test 子进程、
      // autoCommit git、loopGuard——真机实证中断后这些串行步骤照样跑完拖住轮收尾）
      if (this.abort.signal.aborted) {
        this.editedFiles.clear()
        return undefined
      }
      // 纠偏审查·异常信号（2026-09-02 用户拍板；2026-09-03 gate 化）：连续工具失败（模型在
      // 绕圈/踩同一坑）或单轮迭代过长（空转）→ 同步等审查完成再继续（用户实证：异步审查回来
      // 时轮已结束=马后炮；此场景暂停就是止损）。gate 三路竞速：完成（卡经 midTurn 队列在
      // 下一迭代顶部注入=下一动作前）/超时 fail-open/abort 直通。信号关（onSignals=false）
      // 不触发；reviewSignalFiredThisTurn 每轮一次（审阅修复：长失败轮批批命中会连环审查烧钱）
      if (this.cfg().review?.enabled === true && this.cfg().review?.onSignals !== false && !this.reviewSignalFiredThisTurn) {
        this.reviewTurnIterations += 1
        if (
          shouldReviewOnSignal(
            longestConsecutiveErrorRun(round.tools),
            this.reviewTurnIterations,
          )
        ) {
          this.reviewSignalFiredThisTurn = true
          await this.gateSignalReview()
          // 审阅修复（架构席 P1·第二轮）：gate 窗口（默认 60s）内 Ctrl+C 后复查——
          // 原检查只在段首，gate 释放（abort 直通）后 loopGuard/quality/autoCommit 照跑，
          // 重开了「中断后串行步骤照样跑完」的窗口（6d6fcba 引入），且中断态 autoCommit
          // 会提交用户正要放弃的半成品
          if (this.abort.signal.aborted) {
            this.editedFiles.clear()
            return undefined
          }
        }
      }
      // M13-B2：无效轮次检测先行（feedback/abort 注入在 quality 之前——止损优先）
      const guardFb = this.loopGuardRound(round)
      if (guardFb !== undefined) {
        feedback = guardFb
        feedbackMeta = { kind: 'loop-guard' }
      }
      if (deps.quality != null) {
        const fb = await deps.quality.afterRound(round.tools)
        if (fb !== undefined && feedback === undefined) {
          this.publish('notice', { level: 'warn', text: 'lint/test 有失败，已回喂模型自纠' })
          feedback = fb
          feedbackMeta = { kind: 'quality' }
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
      // 2026-09-03 归属根治：通知与 feedback 各带 meta 结构化返回（loop 侧逐条构造 fbMsg；
      // 多源合并进一条 feedback 时 meta 取首个来源——loopGuard 优先，其文本已含止损语义）
      const noteTexts = notes.map((n) => n.text)
      if (feedback !== undefined) {
        return {
          feedback: noteTexts.length > 0 ? `${feedback}\n${noteTexts.join('\n')}` : feedback,
          meta: feedbackMeta,
        }
      }
      if (noteTexts.length > 0) return { feedback: noteTexts.join('\n'), meta: { kind: 'task-notify' } }
      return undefined
    }
  }

  /**
   * M13-B2（#2）三检测器（工具轮——afterTools 时点；纯文本轮复读在 finishTurn）：
   * 跨 Turn 复读（指纹环精确匹配，D3）/ 同参工具（name+input+resultHead 签名连续相同——
   * M13-P1 结果感知：参数同且结果同才算空转，结果变=新信息=清零）/ 连续空错。
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
      // 等待根治（2026-09-03）：wait_ms 上限已提至 5 分钟（TASK_OUTPUT_MAX_WAIT_MS），
      // 「加大 wait_ms」从死路变活路——合法等待本身就是一次长调用而非 N 次短轮询
      feedback = `[loop-guard] 最近 ${this.sigStreak} 轮在以完全相同的参数调用相同工具且结果毫无变化，请重新判断这是否必要（如等待后台任务请单次给足 wait_ms，上限 ${TASK_OUTPUT_MAX_WAIT_MS}）。`
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

  /** 检测 abort：断信号 + systemMsg 可读原因 + 日志（loop 心脏零改动——signal 它本来就在听）。
   *  F-38：文本不带 ⚠ 前缀——图标由各端渲染层统一加（TUI renderNoticeLine/web store warn case），
   *  否则底部行「⚠ ⚠」双图标。 */
  private guardAbort(detector: string, reason: string): void {
    this.abort.abort()
    this.deps.logger.warn('loop-guard', 'abort', { detector, reason })
    this.publish('systemMsg', { text: `[loop-guard] ${reason}，已终止本轮。` })
  }
}
