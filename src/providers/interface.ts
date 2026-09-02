/**
 * LLMProvider 接口（模型接入分支面）。
 *
 * 两层架构（详设 §2.2、解析决策 3）：
 *   - Provider 实现（按 type，无状态）：本接口的实现类，按请求注入配置。
 *   - Provider 配置实例（按 name，从 config 读）：绑 定一个 type + baseURL/apiKey/model。
 * 同一实现服务多实例（如 OpenaiProvider 同时服务 deepseek 和 openai）。
 *
 * 铁律：心脏只按 type 找实现（registry.getByType），不认识具体厂商名。
 */

import type { Delta, Message, ToolSpec } from '../core/types.js'

/** 思考强度枚举（D9）：协议无关语义层，各 Provider 内部翻译成自己的机制 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/**
 * ProviderReq：从 Config 派生的 provider 调用配置（不含 system/messages/tools/signal，
 * 那些由 loop 内部注入）。cli argv + TuiApp submit 共用（buildProviderReq，P1-3 去重）。
 */
export interface ProviderReq {
  /** 配置实例名（astron/deepseek/...），实现用它缓存 SDK client */
  name: string
  baseURL: string
  apiKey: string
  model: string
  // M4 采样参数（per-provider，D4）
  temperature?: number
  topP?: number
  maxTokens?: number
  thinking?: ThinkingLevel
  /** 上下文窗口覆盖（M5 §5 escape hatch；不配则 models.dev 探测） */
  contextWindow?: number
  /**
   * 流停滞看门狗毫秒（P0-B，方案 2026-09-02 真机诊断修复 §2）：流内连续 N ms 零**内容性**
   * delta（text/thinking/tool_use_delta——协议层心跳/空帧不算）→ 中止流；零产出时 provider
   * 内自动重试 1 次，仍停滞或有产出则转 STREAM_STALL 错误（retryable:false 温和终止）。
   * 缺省 90000；0=关闭。非流式 thinking 端点（reasoning 憋到尾部才吐）可调大或关闭。
   */
  streamStallMs?: number
}

/** provider.run 的入参（ProviderReq + loop 内部注入的 system/messages/tools/signal）。 */
export interface LLMProviderRunRequest extends ProviderReq {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  signal?: AbortSignal
}

export interface LLMProvider {
  /** 协议类型：'anthropic' | 'openai' | ...（决定实现层） */
  readonly type: string
  /** 发起流式请求，吐统一 Delta 流（协议事件 → Delta 的翻译封在实现内部） */
  run(req: LLMProviderRunRequest): AsyncIterable<Delta>
}

export interface LLMProviderRegistry {
  register(p: LLMProvider): void
  /** 按 type 取实现（心脏唯一入口） */
  getByType(type: string): LLMProvider
}
