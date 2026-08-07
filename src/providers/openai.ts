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

  async *stream(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncIterable<ECodeStreamPart> {
    const params = {
      ...toOpenAIRequest(request),
      stream: true as const,
      stream_options: { include_usage: true },
    };
    const stream = await this.client.chat.completions.create(
      params,
      options?.signal ? { signal: options.signal } : undefined,
    );
    const toolCallMeta = new Map<number, { id: string; name: string }>();
    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
      // OpenAI 在单独的末尾 chunk 里返回 usage（choices:[]），需在 choice 判断之前处理，
      // 否则会被 `if (!choice) continue` 静默丢弃，生产环境永远拿不到 usage。
      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.prompt_tokens_details?.cached_tokens != null && {
            cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
          ...(chunk.usage.completion_tokens_details?.reasoning_tokens != null && {
            reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens,
          }),
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id && tc.function?.name && !toolCallMeta.has(tc.index)) {
            toolCallMeta.set(tc.index, { id: tc.id, name: tc.function.name });
            yield { type: 'tool_call_start', id: tc.id, name: tc.function.name };
          }
          if (tc.function?.arguments) {
            const id = toolCallMeta.get(tc.index)?.id;
            if (id) yield { type: 'tool_call_delta', id, inputDelta: tc.function.arguments };
          }
        }
      }
      if (choice.finish_reason) {
        yield { type: 'stop', reason: mapOpenAIStopReasonStreaming(choice.finish_reason) };
      }
    }
  }
}

/** 流式 finish_reason → ECodeStopReason（与 transform.mapOpenAIStopReason 同语义，独立避免循环依赖） */
function mapOpenAIStopReasonStreaming(reason: string): import('./types.js').ECodeStopReason {
  switch (reason) {
    case 'stop':
      return { unified: 'stop', raw: reason };
    case 'tool_calls':
      return { unified: 'tool-use', raw: reason };
    case 'length':
      return { unified: 'length', raw: reason };
    case 'content_filter':
      return { unified: 'content-filter', raw: reason };
    default:
      return { unified: 'other', raw: reason };
  }
}
