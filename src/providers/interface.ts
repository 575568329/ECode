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

/** provider.run 的入参（配置由调用方注入，实现无状态）。 */
export interface LLMProviderRunRequest {
  /** 配置实例名（astron/deepseek/...），实现用它缓存 SDK client */
  name: string
  baseURL: string
  apiKey: string
  model: string
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
