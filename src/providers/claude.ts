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

  async *stream(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncIterable<ECodeStreamPart> {
    const params = toAnthropicRequest(request);
    // SDK 0.32.1：messages.stream() 同步返回 MessageStream，其本身实现 AsyncIterable<RawMessageStreamEvent>。
    const msgStream = this.client.messages.stream(
      params,
      options?.signal ? { signal: options.signal } : undefined,
    );
    // index → tool_use id：content_block_delta/stop 需靠 index 反查 id（Anthropic 只在 start 里给 id）
    const toolIdByIndex = new Map<number, string>();
    // MessageStream 即 AsyncIterable<MessageStreamEvent>，MessageStreamEvent = RawMessageStreamEvent
    for await (const ev of msgStream as AsyncIterable<Anthropic.RawMessageStreamEvent>) {
      switch (ev.type) {
        case 'content_block_start': {
          const block = ev.content_block;
          if (block.type === 'tool_use') {
            toolIdByIndex.set(ev.index, block.id);
            yield { type: 'tool_call_start', id: block.id, name: block.name };
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (d.type === 'text_delta') {
            yield { type: 'text_delta', text: d.text };
          } else if (d.type === 'input_json_delta') {
            const id = toolIdByIndex.get(ev.index);
            if (id) yield { type: 'tool_call_delta', id, inputDelta: d.partial_json };
          }
          break;
        }
        case 'content_block_stop': {
          // 仅 tool_use block 产出 tool_call_end（text block 无对应事件，与 OpenAI finish_reason 模式不同）
          const id = toolIdByIndex.get(ev.index);
          if (id) yield { type: 'tool_call_end', id };
          break;
        }
        case 'message_delta': {
          // usage 与 content chunk 分开投递（借鉴 Task 7 教训：独立处理，不耦合 content 逻辑）
          if (ev.usage) {
            yield { type: 'usage', inputTokens: 0, outputTokens: ev.usage.output_tokens };
          }
          yield { type: 'stop', reason: mapAnthropicStopReasonStreaming(ev.delta.stop_reason) };
          break;
        }
        default:
          // message_start / ping / message_stop 等：不产出 ECodeStreamPart
          break;
      }
    }
  }
}

/**
 * 流式 stop_reason → ECodeStopReason。
 * 与 transform.mapAnthropicStopReason 同语义，独立为 local 函数避免循环依赖（对齐 openai.ts 的同名函数）。
 */
function mapAnthropicStopReasonStreaming(
  reason: string | null | undefined,
): import('./types.js').ECodeStopReason {
  switch (reason) {
    case 'end_turn':
      return { unified: 'stop', raw: reason };
    case 'tool_use':
      return { unified: 'tool-use', raw: reason };
    case 'stop_sequence':
      return { unified: 'stop', raw: reason }; // 模型主动停止（非 max_tokens）
    default: // max_tokens / 其它
      return { unified: 'length', raw: reason ?? undefined };
  }
}
