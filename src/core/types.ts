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
}

// ImageBlock 留位（MVP 不实现图像输入，占类型位避免后续破坏性变更）：
// export interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

// system 不进 messages，只走 LLMProvider.run({ system }) 参数（ADR-009）。
// 与 Anthropic 一致；OpenaiProvider 内部把 system 翻译成 messages[0]。
export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

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
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partial_json: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_creation_tokens?: number }
  | { type: 'error'; error: AppError }
  | { type: 'done'; stop_reason: StopReason }
