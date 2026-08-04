import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ECodeResponse, ECodeStreamPart, ModelProvider } from './types.js';
import { toAnthropicRequest, fromAnthropicResponse } from './transform.js';
import { withRetry } from '../retry.js';

export interface ClaudeProviderOptions {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
}

/**
 * Anthropic 原生 Provider：用 @anthropic-ai/sdk，走 Anthropic 协议。
 * complete() = transform 翻译 → SDK 调用（withRetry 包裹）→ transform 翻译回。
 */
export class ClaudeProvider implements ModelProvider {
  readonly name = 'claude';
  readonly protocol = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(opts: ClaudeProviderOptions) {
    this.client = new Anthropic(opts);
  }

  /** SDK 实际 endpoint(含 env ANTHROPIC_BASE_URL 覆盖——排障可见真实请求地址) */
  get baseURL(): string {
    return this.client.baseURL;
  }

  async complete(request: ChatRequest): Promise<ECodeResponse> {
    const params = toAnthropicRequest(request);
    const message = await withRetry(
      () => this.client.messages.create(params),
      `claude:${request.model}`,
    );
    // SDK 单签名返回 Message | Stream 联合，非流式（未传 stream:true）实际是 Message
    return fromAnthropicResponse(message as Anthropic.Message);
  }

  async *stream(request: ChatRequest): AsyncIterable<ECodeStreamPart> {
    throw new Error(`[M3.5] ClaudeProvider.stream() 尚未实现 (model: ${request.model})`);
  }
}
