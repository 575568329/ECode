/**
 * M12 协议规范模型（B0，方案 §3.1）：宿主 ↔ 客户端的事件/命令双枚举。
 *
 * 铁律（§1 四条铁律之一）：**协议即唯一契约，进程内不绕**——TUI/Web/手机三种客户端
 * 消费同一套形状；阶段 1 走 InMemoryChannel（纯数据事件、不共享对象引用），
 * 阶段 2 换 HTTP+SSE 管道时本文件零改动。
 *
 * 归属纪律（v1.2 类型归属约束）：本模块是**叶子**——只 import node 内置，
 * 禁止 import services/tools/tui（防反向依赖；SubagentStatus 等协议引用的类型在
 * 对应批次迁入此处定义，迁移前用视图形态 + unknown 占位并标注收紧点）。
 */

// —— 审批（D6 分策略表）——

/** 审批类别：tool-confirm 可交互可 --yes；sensitive 永远要求交互（无订阅者一律拒绝）；
 *  mcp-permission 在 --yes 下保持拒绝；ask-user/ask-select 为问询类可答帧。 */
export type ApprovalKind = 'tool-confirm' | 'sensitive' | 'mcp-permission' | 'ask-user' | 'ask-select'

export type ApprovalDecision = 'once' | 'always' | 'reject'

/** approval/resolved 的终态除用户三选外还有系统收敛态（超时/轮取消）。 */
export type ApprovalOutcome = ApprovalDecision | 'timeout' | 'cancelled'

// —— 载荷视图（B0 定形，标注各批收紧点）——

/** 图片/文档载荷（O-3 待拍板：B0 先定路径引用形态——TUI 本机同进程倾向路径；
 *  base64 形态在 B3 接线/B7 HTTP 时定） */
export interface ImagePayload {
  path: string
  mime: string
  /** 输入框引用标签（[图片#N] 等），宿主侧只作回显关联 */
  label?: string
}

/** 子代理进度视图（B4 时从 services/subagent.ts 的 SubagentStatus 收敛迁入）。
 *  审阅修复批：补 startedAt/waitingSince——帧 payload 实际已携带（折叠行总时长的数据源），
 *  此前客户端靠 as 强转缝合，违反「View 契约冻结在此」纪律（可选字段向后兼容）。 */
export interface SubagentStatusView {
  id: string
  description: string
  activity: string
  /** 子代理启动时刻（折叠行总时长起点；旧宿主帧可缺省） */
  startedAt?: number
  /** 最近进入 LLM 等待的时刻（transcript 阶段节奏推算用；可缺省） */
  waitingSince?: number
}

/** MCP 服务状态视图（B5 面板数据化时对齐 McpManager 实际形态收紧） */
export interface McpServerStatusView {
  name: string
  status: string
}

/** 宿主 → 客户端事件（全部纯数据可序列化——JSON roundtrip 是协议纪律，测试锁定）。
 *  seq 会话级单调（宿主侧通道分配）：顺序/去重/分页游标三用。 */
export type ProtocolEvent =
  | { type: 'delta'; seq: number; turnId: string; text: string }
  | { type: 'thinking'; seq: number; turnId: string; blockIndex: number; text: string }
  | { type: 'thinking/ended'; seq: number; turnId: string; blockIndex: number; durMs: number }
  | { type: 'item/started'; seq: number; turnId: string; itemId: string; name: string }
  | { type: 'item/executing'; seq: number; turnId: string; itemId: string; digest: string }
  | { type: 'item/completed'; seq: number; itemId: string; name: string; isError: boolean; summary: string; content: string; truncated?: boolean; use?: unknown }
  | { type: 'usage'; seq: number; input: number; output: number; cacheRead?: number; cacheCreation?: number; costCny?: number; /** F-44：当前上下文占用（input+cacheRead，API 真值）与模型窗口（resolveContextWindow）——StatusBar ctx 段 */ contextUsed?: number; contextWindow?: number }
  | { type: 'turn/started'; seq: number; turnId: string; userInput?: string; userInputMeta?: PromptMeta }
  | { type: 'turn/completed'; seq: number; turnId: string }
  | { type: 'thread/status'; seq: number; busy: boolean; waitingOn: 'approval' | 'userInput' | null; iter: number; maxIter?: number }
  /** 批 2（2026-08-30）：会话元数据更新广播（归档/恢复/重命名）——多端列表同步 */
  | { type: 'session/updated'; seq: number; sessionId: string; title?: string; archived?: boolean }
  /** 批 4（W-9）：断线重连订阅基线——lastSeq=通道当前 seq；gap=true=缓冲覆盖不到 sinceSeq，客户端须全量重同步 */
  | { type: 'session/subscribed'; seq: number; sessionId: string; lastSeq: number; gap: boolean }
  | { type: 'approval/requested'; seq: number; requestId: string; kind: ApprovalKind; tool: string; preview: string; decisions: ApprovalDecision[] }
  | { type: 'approval/claimed'; seq: number; requestId: string; claimant: string }
  | { type: 'approval/resolved'; seq: number; requestId: string; outcome: ApprovalOutcome }
  | { type: 'askUser/requested'; seq: number; requestId: string; questions: unknown[] } // B2 迁 AskUserQuestion 时收紧
  | { type: 'askUser/resolved'; seq: number; requestId: string; answers: unknown }
  | { type: 'askSelect/requested'; seq: number; requestId: string; title: string; options: string[] }
  | { type: 'askSelect/resolved'; seq: number; requestId: string; choice: string | null }
  | { type: 'interjection/enqueued'; seq: number; text: string }
  | { type: 'interjection/injected'; seq: number; text: string }
  | { type: 'queue/snapshot'; seq: number; items: string[] }
  | { type: 'session/clear'; seq: number } // 清账 III P1-3：宿主权威清空广播（serve 端 /clear 分流时发——web 视图与 TUI 对齐）
  /** T1：rewind 已在宿主执行完毕（留痕+文件还原）——客户端收到后以 session/read 全量重拉重建视图 */
  | { type: 'rewind/applied'; seq: number; toolUseId?: string; time: string }
  | { type: 'notice'; seq: number; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'systemMsg'; seq: number; text: string } // 输入框上方反馈（read-only 拒绝提示等），与 notice（告警中心）双通道
  | { type: 'subagent/progress'; seq: number; agents: SubagentStatusView[] }
  | { type: 'todo/snapshot'; seq: number; todos: unknown[] } // B5 命令 host 化时对齐 todo 工具形态收紧
  | { type: 'warn'; seq: number; text: string }
  | { type: 'error'; seq: number; message: string; code?: string }
  | { type: 'activity'; seq: number; state: string; text?: string; retrying?: boolean }
  | { type: 'compacting'; seq: number; detail?: string }
  | { type: 'compacted'; seq: number; detail?: string }
  | { type: 'compactFailed'; seq: number; detail?: string }
  /** 信号 gate（2026-09-03）：审查同步等待期——active true 开始/false 结束（含超时与异常）。
   *  TUI 映射到 loading 行 phase（spinner+计时）；web/旧客户端 default 无视（协议容错）。 */
  | { type: 'reviewing'; seq: number; active: boolean }
  | { type: 'config/changed'; seq: number; config: unknown } // B3 接 config 权威源时收紧为 ConfigView
  | { type: 'mcp/status'; seq: number; servers: McpServerStatusView[] }
  /** 档位变更广播（会话级——用户拍板 2026-09-02：同项目不同对话不互相影响，档位属活动
   *  会话实例；channel 会话私有 + mux 信封 sessionId 天然隔离，他对话订阅端收不到）。
   *  sandbox/set 成功后与 restoreFrom 换会话归零时发布：同对话多端显示即时对齐，
   *  本端切档回声 applySandboxMode 幂等无害 */
  | { type: 'sandbox/mode'; seq: number; mode: 'default' | 'accept-edits' | 'read-only' | 'workspace-write' | 'full-access' }

/** 发布形态：宿主侧 publish 时不带 seq（通道分配），HTTP 形态服务端帧同理 */
export type PublishableEvent = DistributiveOmit<ProtocolEvent, 'seq'>
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

// —— 客户端 → 宿主命令 ——

/** 插话/排队三态（codex TurnInputMode；M11 双时点插话的协议化） */
export type PromptMode = 'StartOrSteer' | 'StartIfIdle' | { Steer: { expectedTurnId: string } }

/** prompt 命令的机器消息标记（2026-09-03 归属根治 P2-1/P2-3；叶子模块视图形态——
 *  收紧点：core/types MessageMeta 迁入协议时合并同构）。宿主侧收窄为 MessageMeta。 */
export type PromptMeta = { kind: 'task-notify' | 'loop-guard' | 'quality' | 'continue' | 'review-card' | 'interject' | 'system-notice' }

export type PromptRouted = 'Started' | 'Steered' | 'Queued' | 'Rejected' | 'Command'

/** T1 rewind 协议面回执契约（shape 冻结——RewindPanel 协议适配器与 web 端共同消费）。
 *  externallyChanged 在宿主侧预计算（list 即带，客户端免 detectExternalChanges 二次往返）。 */
export interface RewindSnapshotView {
  seq: number
  time: string
  tool: string
  messageId?: string
  files: Array<{ path: string; hash: string }>
  externallyChanged: string[]
}
export interface RewindListResult {
  sessionId: string
  snapshots: RewindSnapshotView[]
}
export interface RewindExecResult {
  restored: string[]
  externalChanged: string[]
}

/** T1 panel/data 回执契约（D-T2：plugin 挂账——读面只覆盖 skill/mcp；shape 冻结，装配层映射真件） */
export interface SkillPanelView {
  skills: Array<{
    name: string
    description: string
    source: 'user' | 'project' | 'plugin' | 'builtin'
    userInvocable: boolean
    disableModelInvocation: boolean
    whenToUse?: string
  }>
  /** 同名遮蔽（路径/来源 shadow）条数——面板警示行 */
  shadowedCount: number
}
export interface McpPanelView {
  servers: Array<{
    name: string
    status: string
    source: string
    type: string
    toolCount: number
    error?: string
    failedAgoSec?: number
    lifecycle: string
  }>
  /** server 名 → 工具清单（面板展开与补全消费；description 缺省=server 未提供） */
  tools: Record<string, Array<{ name: string; description?: string }>>
}

export type ProtocolCommand =
  | { op: 'prompt'; text: string; mode: PromptMode; images?: ImagePayload[]; meta?: PromptMeta }
  | { op: 'approval/respond'; requestId: string; decision: ApprovalDecision; message?: string }
  | { op: 'approval/claim'; requestId: string; claimant?: string }
  | { op: 'askUser/respond'; requestId: string; answers: unknown }
  | { op: 'askSelect/respond'; requestId: string; choice: string | null }
  | { op: 'interrupt' }
  | { op: 'interjection/clear' }
  | { op: 'session/list'; includeArchived?: boolean }
  | { op: 'session/read'; sessionId: string; fromLine?: number; limit?: number }
  /** 批 2（2026-08-30）：归档/恢复会话（meta sidecar 标记；session/list 默认过滤 archived） */
  | { op: 'session/archive'; sessionId: string; archived: boolean }
  /** 批 2：手动重命名（pin 语义——覆盖 firstUser 显示） */
  | { op: 'session/rename'; sessionId: string; title: string }
  /** M14-C1⑤ 工具全文按需读取（帧内 content 已截断 4KB——summary+read 分野；上限 1MB） */
  | { op: 'item/read'; itemId: string }
  /** T 线②：fork 续写宿主化——true 时宿主完成「起新 id 播种+快照目录跟随+SessionStart(resume)」，
   *  回执 value 带新 sessionId（原 TUI 客户端 restoreSession 手搓三步移入，附着/本地两形态行为一致） */
  | { op: 'session/restore'; sessionId: string; fork?: boolean }
  /** 真新建会话（web「+新对话」）——项目级命令，serve 信封层（multi.ts）直接拦截不走会话
   *  dispatch：经会话承载会让冷项目为承载命令多起一个空默认会话；回执 sessionId。 */
  | { op: 'session/new' }
  | { op: 'session/clear' }
  | { op: 'rewind/list' }
  /** T1 契约（2026-08-31）：回执 value=RewindListResult（快照列表+各点外部修改标注）；
   *  exec 回执 value=RewindExecResult（restored 文件列表）；busy 守卫拒绝运行中执行 */
  | { op: 'rewind/exec'; target: number }  /** T1：面板数据（plugin 挂账 D-T2；doctor 是 prompt 注入命令非面板）。
   *  2026-09-03 扩 'tasks'：宿主 TaskRegistry.snapshot()——attach 态客户端进程单例查不到
   *  daemon 侧任务（Ctrl+T 详情根菜单/TasksBar 数据源）。 */
  | { op: 'panel/data'; panel: 'skill' | 'mcp' | 'tasks' }
  /** T1：MCP 面板写动作（reconnect/close 单 server） */
  | { op: 'mcp/action'; action: 'reconnect' | 'close'; server: string }
  /** T1：项目 .mcp.json 首用批准门（附着态 MCP manager 在 daemon，此门必须过协议） */
  | { op: 'mcp/approve'; file: string; approved: boolean }
  /** T1：压缩链宿主权威触发（与 /compact 分流同路径） */
  | { op: 'session/compact' }
  | { op: 'model/set'; provider: string; model: string }
  | { op: 'sandbox/set'; mode: 'default' | 'accept-edits' | 'read-only' | 'workspace-write' | 'full-access' }
  /** 档位权威在宿主——附着启动/daemon 重拉重连时点拉当前档对齐本地显示（宿主档位是
   *  运行态内存字段，daemon 重拉后 HostSession 重建回 config 默认；客户端显示不刷新
   *  ＝「显示 read-only 实际 default 全放行」的假安全）。回执 value={ mode } */
  | { op: 'sandbox/get' }
  | { op: 'config/get' }

/** 命令回执：宿主永不 throw 到客户端（错误收敛为 ok:false——与 approval/respond 的
 *  receipt 语义一致，权威状态走事件）。B1 起各命令的 value 形态逐批收紧。 */
export type CommandResult = PromptResult | CommandOk | CommandError

export interface PromptResult extends CommandOk {
  routed: PromptRouted
}
export interface CommandOk {
  ok: true
  value?: unknown
  /** F-23：host 命令分流的输出文本（routed:'Command' 时给 web 端直接展示；同文本也走 systemMsg 帧） */
  output?: string
  /** M13-W2：路由命中的会话 id（信封路由/隐式建会话时回执——TuiApp 同进程路径不填） */
  sessionId?: string
}
export interface CommandError {
  ok: false
  error: string
  code?: string
}
