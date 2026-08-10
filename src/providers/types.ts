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

/**
 * 工具结果输出 —— 判别联合（v2 升级）。
 * v1: tool_result 用 content:string + is_error?:boolean（扁平，语义模糊）。
 * v2: 收敛为 output 判别联合（text/error/json），Provider 翻译时从协议格式映射到对应 variant。
 * Why: 结构化结果（json）预留 + 错误语义显式化 + 与 Vercel providerOptions 模式对齐。
 */
export type ECodeToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'error'; value: string }
  | { type: 'json'; value: unknown };

/** 图片来源 —— base64 编码（参考 Anthropic Base64ImageSource 结构，ECode 内部统一表示） */
export interface ImageSource {
  type: 'base64';
  mediaType: string; // 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  data: string; // base64 编码字符串
}

/** 内部统一内容块 —— 判别联合，靠 type 字段收窄 */
export type ECodeContentBlock =
  | { type: 'text'; text: string; providerOptions?: Record<string, unknown> }
  | { type: 'image'; source: ImageSource; providerOptions?: Record<string, unknown> }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; providerOptions?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; output: ECodeToolResultOutput; providerOptions?: Record<string, unknown> };

/** 内部统一消息 */
export interface ECodeMessage {
  role: 'user' | 'assistant';
  content: string | ECodeContentBlock[];
}

/**
 * 内部统一的停止原因（信息保真）。
 * unified: agent loop 用这 6 个值做决策（语义清晰、跨 provider 一致）。
 * raw?: 保留 provider 原始值，用于调试（如 'model_context_window_exceeded' vs 'max_tokens'）。
 */
export type ECodeStopReason = {
  unified: 'stop' | 'length' | 'tool-use' | 'content-filter' | 'error' | 'other';
  raw?: string;
};

/** 借鉴 Vercel warnings:transform 遇到不支持/降级的情况时,降级而非抛错,让 agent loop 可感知 */
export type ECodeWarning =
  | { type: 'unsupported'; feature: string; details?: string }
  | { type: 'compatibility'; feature: string; details?: string };

/**
 * LLM 调用 token 用量。input/output 必有；cache/reasoning 可选。
 * 可选项防御 GLM/DeepSeek 等兼容端点不返回这些字段（undefined = 未提供，区别于 0）。
 */
export interface ECodeUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存的输入 token（Anthropic cache_read_input_tokens / OpenAI prompt_tokens_details.cached_tokens） */
  cacheReadTokens?: number;
  /** 写入缓存的输入 token（Anthropic cache_creation_input_tokens） */
  cacheWriteTokens?: number;
  /** 推理 token（DeepSeek-R1 / o1 等推理模型的 completion_tokens_details.reasoning_tokens） */
  reasoningTokens?: number;
}

/** 统一 LLM 响应（Provider 翻译掉协议外壳后返回） */
export interface ECodeResponse {
  content: ECodeContentBlock[]; // 仅 text + tool_call
  stopReason: ECodeStopReason;
  usage: ECodeUsage;
  /** transform 收集的警告信息（降级/不支持），agent loop 可选打印或决策 */
  warnings?: ECodeWarning[];
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

/**
 * 流式响应的单个 chunk（M3.5 实现，M3 仅占位类型）。
 * 定义在此避免 M3.5 时改 ModelProvider 接口。
 */
export type ECodeStreamPart =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'tool_call_end'; id: string }
  | ({ type: 'usage' } & ECodeUsage)
  | { type: 'stop'; reason: ECodeStopReason };

/** Provider 接口 —— agent loop 唯一依赖，换模型 = 换 Provider 实例 */
export interface ModelProvider {
  readonly name: string; // 'claude' | 'openai'
  readonly protocol: 'anthropic' | 'openai';
  /** SDK 实际使用的 endpoint(含环境变量覆盖后的最终值,排障可见真实请求地址) */
  readonly baseURL: string;
  /** 非流式：一次性返回完整响应。agent loop 当前唯一入口 */
  complete(request: ChatRequest): Promise<ECodeResponse>;
  /**
   * 流式：逐 chunk 返回（M3.5 实现）。
   * @param options.signal 可选 AbortSignal，中断时停止迭代（M3.5 中断机制用）。
   */
  stream(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncIterable<ECodeStreamPart>;
}

/** 模型能力（静态声明，不做 runtime 探测） */
export type ModelCapability = 'tools' | 'vision' | 'thinking' | 'fast_mode';

/** 模型单价（$/M token，支点17 cost 精确化）。未配置时该档按 0 计费（兼容旧 config）。 */
export interface ModelCost {
  /** 非缓存输入 token 单价 */
  input?: number;
  /** 输出 token 单价（含 reasoning，DeepSeek-R1 等推理 token 计入 completion） */
  output?: number;
  /** 命中缓存的输入 token 单价（通常远低于 input） */
  cacheRead?: number;
  /** 写入缓存的输入 token 单价（Anthropic cache_creation） */
  cacheWrite?: number;
}

/** 单个模型的配置（config.json 的 providers.<id>.models[modelName]，provider 由父级 key 隐含） */
export interface ModelConfig {
  capabilities: ModelCapability[];
  /** 模型上下文窗口大小（token），供 ContextManager 算压缩阈值 */
  contextWindow?: number;
  /** 模型单价（$/M token），缺省则该模型不计费显示 --。 */
  cost?: ModelCost;
}
