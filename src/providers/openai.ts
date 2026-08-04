import OpenAI from 'openai';
import type { ChatRequest, ECodeResponse, ECodeStreamPart, ModelProvider } from './types.js';
import { toOpenAIRequest, fromOpenAIResponse } from './transform.js';
import { withRetry } from '../retry.js';

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

/**
 * OpenAI 兼容 Provider：用 openai SDK，走 OpenAI 协议（GLM/DeepSeek 等兼容端点都走它）。
 * 与 ClaudeProvider 同构：transform 翻译 → SDK 调用 → transform 翻译回。
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  readonly protocol = 'openai' as const;
  private readonly client: OpenAI;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI(opts);
  }

  /** SDK 实际 endpoint(构造时确定,含 env OPENAI_BASE_URL 覆盖——排障可见真实请求地址) */
  get baseURL(): string {
    return this.client.baseURL;
  }

  async complete(request: ChatRequest): Promise<ECodeResponse> {
    const params = toOpenAIRequest(request);
    const completion = await withRetry(
      () => this.client.chat.completions.create(params),
      `openai:${request.model}`,
    );
    // create 单签名返回 ChatCompletion | Stream 联合，非流式实际是 ChatCompletion
    return fromOpenAIResponse(completion as OpenAI.Chat.ChatCompletion);
  }

  async *stream(request: ChatRequest): AsyncIterable<ECodeStreamPart> {
    throw new Error(`[M3.5] OpenAIProvider.stream() 尚未实现 (model: ${request.model})`);
  }
}
