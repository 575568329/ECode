/**
 * ECode 规范模型（全系统唯一通用格式）
 *
 * 心脏（AgentLoop）、工具、历史、Provider 翻译层都只认这套模型。
 * 各 LLM 厂商协议差异封在 Provider 实现内部（翻译职责）。
 *
 * 详设 §2.1。唯一铁律：心脏永不出现 `if provider === 'xxx'`。
 */

// —— 统一错误对象（详设 §6.1，归类在规范模型以便 Delta.error 引用）——
export interface AppError {
  /** 机器可读错误码，如 'NO_API_KEY' / 'TOOL_NOT_FOUND' / 'RATE_LIMIT' */
  code: string
  /** 人类可读错误信息 */
  message: string
  /** 额外上下文（已脱敏） */
  context?: Record<string, unknown>
  /** true→转 tool_result(is_error:true) 给 LLM 自纠；false→抛顶层中断 Loop */
  recoverable: boolean
  /** true→Provider 层指数退避重试（网络/超时/429） */
  retryable?: boolean
}

// —— 内容块：盖住 text / 工具调用 / 工具结果三种形态 ——
export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  /**
   * M10-P0：多模态附着块（image/document）——tool_result 的非文本载荷。
   * content 主路径保持 string（byteLength/渲染/serialize 零破坏）；Anthropic 翻译时
   * 组装为 content 数组（text + blocks），OpenAI 翻译时转移至紧随 user 消息（协议约束）。
   */
  blocks?: Array<ImageBlock | DocumentBlock>
}

/** 图片块（M10-P0；source 形态与 Anthropic 协议完全一致——透传零翻译）。 */
export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }
  /** 尺寸元信息（token 估算 (w×h)/750 用；读入时解析，非协议字段不外发） */
  _w?: number
  _h?: number
  /** 源文件路径（M10-P2b 粘贴场景：history 落盘转 ImageRef 的引用路径；协议侧剥除） */
  _path?: string
}

/** PDF 文档块（M10-P0；Anthropic document block 同构）。 */
export interface DocumentBlock {
  type: 'document'
  source: { type: 'base64'; media_type: 'application/pdf'; data: string }
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | DocumentBlock

/**
 * 图片引用块（M10-P2b，**仅存储态**——history 落盘时 ImageBlock 的序列化形态，内存态不存在）：
 * base64 不进会话文件（几十 KB×N 撑爆）；恢复时按 path 重读转回 ImageBlock，文件缺失降级 TextBlock 占位。
 */
export interface ImageRefBlock {
  type: 'image_ref'
  path: string
  media_type: ImageBlock['source']['media_type']
}

// system 不进 messages，只走 LLMProvider.run({ system }) 参数（ADR-009）。
// 与 Anthropic 一致；OpenaiProvider 内部把 system 翻译成 messages[0]。
export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
  /**
   * 机器/系统注入标记（2026-09-03 机器消息归属根治）：标记「这条 user 角色消息是系统产物」。
   * 模型侧语义不变（仍以 user 角色可见——tool_result 配对约束决定信息性回喂只能走 user 通道）；
   * 显示层据此分流（不渲染成用户气泡——历史上 [task]/[loop-guard] 通知曾顶着 ❯ 气泡出现）；
   * 协议翻译层剥除（不外发）。用户消息**永无此字段**（判据即存在性，无需枚举比对）。
   * 详见 docs/详设/2026-09-03_后续-机器消息归属错位诊断与根治方案_待审核.md。
   */
  meta?: MessageMeta
}

/** 机器消息来源枚举（显示层可按 kind 细分样式；混排多条时宿主折叠为 system-notice）。 */
export type MessageMeta =
  | { kind: 'task-notify' } // 后台任务完成/失败通知（tasks.collectNotifications）
  | { kind: 'loop-guard' } // loopGuard nudge/abort 回喂（session.loopGuardRound）
  | { kind: 'quality' } // lint/test 质量回喂（makeAfterTools quality 段）
  | { kind: 'continue' } // max_tokens 自动续写指令（CONTINUE_PROMPT）
  | { kind: 'review-card' } // 纠偏审查卡（maybeRunReview / pollUserInput kind:'review'）
  | { kind: 'interject' } // 轮中用户插话（含宿主包装体——渲染为插话样式）
  | { kind: 'system-notice' } // 通用系统通知（多种机器消息合并为一条时的兜底 kind）

// 工具对外规格（JSON Schema，直接喂 LLM 协议格式）
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema（MVP 扁平化：type + properties + required + 基础约束） */
  input_schema: object
}

// 一轮回复的停止原因
export type StopReason =
  | 'end' // LLM 正常结束
  | 'tool_use' // LLM 要求工具调用
  | 'length' // 达 max_tokens（输出被截断，输入"继续"可续写）
  | 'error' // 流内错误
  | 'aborted' // 用户 Ctrl+C 中断
  | 'content_filter' // 内容安全过滤

// —— 统一流式增量：心脏与消费方只消费这个 ——
// error: 流中途失败（网络断、畸形事件、parse 失败），发出后不再有 done。
// usage: token 用量，Provider 在 done 前或流末尾发出。
export type Delta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; blockIndex: number; text: string }
  | { type: 'thinking_end'; blockIndex: number }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partial_json: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_creation_tokens?: number }
  | { type: 'error'; error: AppError }
  | { type: 'done'; stop_reason: StopReason }

// —— 压缩边界（M5 §7）：history 存 Message | BoundaryLine 联合，buildContextMessages 识别最后一个 boundary 投影 ——
/** 压缩边界行（投影锚点）。append-only 追加到 history，不删旧消息。 */
export interface BoundaryLine {
  compact_boundary: true
  summary: string
  tailStartIndex: number
  preTokens: number
}

/** 回退标记（M9-P2）：/rewind 确认后追加；投影截断到 toolUseId 所在消息之前（当次改动不进上下文）。 */
export interface RewindLine {
  rewind: true
  /** 截断锚：被回退的第一个工具消息的 tool_use id（checkpoint meta.messageId；失联则忽略截断） */
  toolUseId?: string
  /** 面板选择的快照点序号（展示/审计用） */
  seq: number
  time: string
}

/** 思考行（活动流 D4-B）：thinking_end 时宿主追加的**非消息行**——回看有痕、投影零影响
 *  （isMessageLine 排除=不进 LLM 上下文；与 BoundaryLine/RewindLine 同机制先例）。
 *  落盘全文与 Message 原文同权（HistoryStore 有意不脱敏，P0-6 边界）。 */
export interface ThinkingLine {
  thinking: true
  text: string
  /** 思考持续毫秒（宿主在 thinking_end 算好随行落盘——时钟权威在宿主侧） */
  durMs: number
  time: string
}

/** history 存储行：消息 or 边界 or 回退 or 思考标记（联合类型，避免标记行破坏 Message 结构，M5 §11/M9-P2/活动流 D4-B）。 */
export type HistoryLine = Message | BoundaryLine | RewindLine | ThinkingLine

/** boundary 类型守卫。 */
export function isBoundary(line: HistoryLine): line is BoundaryLine {
  return typeof line === 'object' && line !== null && (line as BoundaryLine).compact_boundary === true
}

/** rewind 类型守卫（M9-P2）。 */
export function isRewind(line: HistoryLine): line is RewindLine {
  return typeof line === 'object' && line !== null && (line as RewindLine).rewind === true
}

/** thinking 行守卫（活动流 D4-B）。 */
export function isThinking(line: HistoryLine): line is ThinkingLine {
  return typeof line === 'object' && line !== null && (line as ThinkingLine).thinking === true
}

/** Message 行守卫（非标记行）——消费点统一用此过滤，防新标记变体漏进 LLM 上下文（M9-P2 收敛；活动流 B2 扩 thinking）。 */
export function isMessageLine(line: HistoryLine): line is Message {
  return !isBoundary(line) && !isRewind(line) && !isThinking(line)
}

/** 默认单次输出上限（max_tokens；审阅 P2 单源化）：provider 兜底（anthropic.ts）与
 *  config 模板/向导默认（config.ts）引用同一常量——曾 32000/32768 两处字面量分叉。
 *  对标定值（2026-08-30 调研）：CC/opencode 均 32k；8192 在 thinking medium（budget 计入
 *  max_tokens）下可见文本可被思考吃光（真机报障实证）。 */
export const DEFAULT_MAX_TOKENS = 32768

/** D-T8（2026-08-31 拍板）：审批超时的模型侧反馈——如实「无人应答」而非谎称「用户拒绝」，
 *  并引导模型自主决策（替代方案/跳过+记录待办）。定义在 core（loop 消费层识别它走专用文案，
 *  不冠「用户拒绝」前缀）；host/approval re-export（broker 超时收敛 resolve 此串）。 */
export const APPROVAL_TIMEOUT_FEEDBACK =
  '审批超时：用户当前不在电脑或手机前，未能在时限内应答（并非拒绝）。请自行决策：优先改用无需确认的只读或安全替代方案；确无替代则跳过本操作，并在最终回复中明确记录该待办，等用户回来处理。'

/** 2026-09-03 全功能走查修复：零可应答订阅者 fail-closed 的如实反馈（原裸 false 被 loop
 *  冠「用户已取消」——serve 会话无 canAnswer 客户端时模型误读为用户主动取消；与超时串同款
 *  透传语义，不冠「用户拒绝」前缀）。 */
export const APPROVAL_NO_CHANNEL_FEEDBACK =
  '当前没有可应答的客户端在线（serve 会话需 web/TUI 等交互端连接才能确认此类操作），操作未执行（并非用户拒绝）。请改用无需确认的只读或安全方式推进，或在回复中记录待办等用户在线时处理。'
