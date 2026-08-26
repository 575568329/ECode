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

/** 子代理进度视图（B4 时从 services/subagent.ts 的 SubagentStatus 收敛迁入） */
export interface SubagentStatusView {
  id: string
  description: string
  activity: string
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
  | { type: 'item/started'; seq: number; itemId: string; name: string }
  | { type: 'item/completed'; seq: number; itemId: string; name: string; isError: boolean; summary: string; content: string; use?: unknown }
  | { type: 'usage'; seq: number; input: number; output: number; cacheRead?: number; cacheCreation?: number; costCny?: number }
  | { type: 'turn/started'; seq: number; turnId: string }
  | { type: 'turn/completed'; seq: number; turnId: string }
  | { type: 'thread/status'; seq: number; busy: boolean; waitingOn: 'approval' | 'userInput' | null; iter: number; maxIter?: number }
  | { type: 'approval/requested'; seq: number; requestId: string; kind: ApprovalKind; tool: string; preview: string; decisions: ApprovalDecision[] }
  | { type: 'approval/resolved'; seq: number; requestId: string; outcome: ApprovalOutcome }
  | { type: 'askUser/requested'; seq: number; requestId: string; questions: unknown[] } // B2 迁 AskUserQuestion 时收紧
  | { type: 'askUser/resolved'; seq: number; requestId: string; answers: unknown }
  | { type: 'askSelect/requested'; seq: number; requestId: string; title: string; options: string[] }
  | { type: 'askSelect/resolved'; seq: number; requestId: string; choice: string | null }
  | { type: 'interjection/enqueued'; seq: number; text: string }
  | { type: 'interjection/injected'; seq: number; text: string }
  | { type: 'queue/snapshot'; seq: number; items: string[] }
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
  | { type: 'config/changed'; seq: number; config: unknown } // B3 接 config 权威源时收紧为 ConfigView
  | { type: 'mcp/status'; seq: number; servers: McpServerStatusView[] }

/** 发布形态：宿主侧 publish 时不带 seq（通道分配），HTTP 形态服务端帧同理 */
export type PublishableEvent = DistributiveOmit<ProtocolEvent, 'seq'>
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

// —— 客户端 → 宿主命令 ——

/** 插话/排队三态（codex TurnInputMode；M11 双时点插话的协议化） */
export type PromptMode = 'StartOrSteer' | 'StartIfIdle' | { Steer: { expectedTurnId: string } }

export type PromptRouted = 'Started' | 'Steered' | 'Queued' | 'Rejected'

export type ProtocolCommand =
  | { op: 'prompt'; text: string; mode: PromptMode; images?: ImagePayload[] }
  | { op: 'approval/respond'; requestId: string; decision: ApprovalDecision }
  | { op: 'askUser/respond'; requestId: string; answers: unknown }
  | { op: 'askSelect/respond'; requestId: string; choice: string | null }
  | { op: 'interrupt' }
  | { op: 'interjection/clear' }
  | { op: 'command/exec'; name: string; args?: string }
  | { op: 'session/list' }
  | { op: 'session/read'; sessionId: string; beforeSeq?: number; limit?: number }
  | { op: 'session/restore'; sessionId: string }
  /** 真新建会话（web「+新对话」）——项目级命令，serve 信封层（multi.ts）直接拦截不走会话
   *  dispatch：经会话承载会让冷项目为承载命令多起一个空默认会话；回执 sessionId。 */
  | { op: 'session/new' }
  | { op: 'session/clear' }
  | { op: 'rewind/list' }
  | { op: 'rewind/exec'; target: number }
  | { op: 'panel/data'; panel: 'skill' | 'mcp' | 'plugin' | 'doctor' }
  | { op: 'model/set'; provider: string; model: string }
  | { op: 'sandbox/set'; mode: 'default' | 'read-only' | 'workspace-write' | 'full-access' }
  | { op: 'config/get' }
  | { op: 'config/patch'; patch: Record<string, unknown> }

/** 命令回执：宿主永不 throw 到客户端（错误收敛为 ok:false——与 approval/respond 的
 *  receipt 语义一致，权威状态走事件）。B1 起各命令的 value 形态逐批收紧。 */
export type CommandResult = PromptResult | CommandOk | CommandError

export interface PromptResult extends CommandOk {
  routed: PromptRouted
}
export interface CommandOk {
  ok: true
  value?: unknown
  /** M13-W2：路由命中的会话 id（信封路由/隐式建会话时回执——TuiApp 同进程路径不填） */
  sessionId?: string
}
export interface CommandError {
  ok: false
  error: string
  code?: string
}
