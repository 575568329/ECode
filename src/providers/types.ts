// ============================================================
// Provider 层契约 —— ECode 内部统一格式 + Provider 接口
// ============================================================
//
// 这是 M2 最关键的文件：agent loop 和各 Provider 都只依赖这里的类型。
// agent loop 不 import 任何 SDK，只认 ECode 内部格式；各 Provider 负责翻译。
//
// 设计：内部格式用「判别联合」（discriminated union），靠 type 字段收窄分流。
// （TS 知识缺口 #1：判别联合 —— 用 type 字面量区分，switch/block.type 能自动收窄）
// ============================================================

/** 内部统一内容块 —— 判别联合，靠 type 字段收窄 */
export type ECodeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** 内部统一消息 */
export interface ECodeMessage {
  role: 'user' | 'assistant';
  content: string | ECodeContentBlock[];
}

/** 统一 LLM 响应（Provider 翻译掉协议外壳后返回） */
export interface ECodeResponse {
  content: ECodeContentBlock[]; // 仅 text + tool_call
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { inputTokens: number; outputTokens: number };
}

/** 统一工具定义（中性命名 parameters，非 Anthropic 的 input_schema） */
export interface ECodeToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** 一次 LLM 调用的请求（agent loop → Provider） */
export interface ChatRequest {
  model: string;
  system: string;
  messages: ECodeMessage[];
  tools: ECodeToolDefinition[];
  maxTokens?: number;
}

/** Provider 接口 —— agent loop 唯一依赖，换模型 = 换 Provider 实例 */
export interface ModelProvider {
  readonly name: string; // 'claude' | 'openai'
  readonly protocol: 'anthropic' | 'openai';
  /** 非流式：一次性返回完整响应。agent loop 当前唯一入口 */
  complete(request: ChatRequest): Promise<ECodeResponse>;
  // TODO(M3+): stream(request: ChatRequest): AsyncIterable<ECodeStreamChunk>;
}

/** 模型能力（静态声明，不做 runtime 探测） */
export type ModelCapability = 'tools' | 'vision' | 'thinking' | 'fast_mode';

/** 单个模型的配置（config.json 的 models[modelName]） */
export interface ModelConfig {
  provider: string; // 指向 config.providers 的 key
  capabilities: ModelCapability[];
}
