/**
 * AnthropicProvider：接 Astron 的 Anthropic 兼容端点（跑 GLM-5.2）。
 *
 * 职责（详设 §2.2）：协议事件 → 统一 Delta 的翻译封在本文件内部。
 *   - translateAnthropicStream：纯函数，批量翻译事件序列（便于单测）
 *   - Translator：有状态翻译器（index → block 映射），run 用它逐事件 yield
 *   - toAnthropicMsgs：规范 Message → Anthropic 协议 messages（结构贴近，基本透传）
 *
 * client 按 name 缓存（同一配置实例复用，避免每轮 new）。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, LLMProviderRunRequest } from './interface.js'
import type { Delta, Message, StopReason } from '../core/types.js'

/** M1 默认输出上限（max_tokens 是 SDK 必填；M4 从 config 透传）。 */
const DEFAULT_MAX_TOKENS = 8192

/** SDK 流式事件的 usage 形状（input/output/cache，各字段都可能缺失）。 */
interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
}

/** SDK 流式事件（宽松结构，按 Anthropic 协议；不硬依赖 SDK 内部类型）。 */
interface RawEvent {
  type: string
  index?: number
  message?: { usage?: RawUsage }
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string }
  usage?: RawUsage
  error?: { message?: string }
  [k: string]: unknown
}

/** Anthropic stop_reason → 规范 StopReason。 */
function mapStopReason(r: unknown): StopReason {
  switch (r) {
    case 'end_turn':
      return 'end'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'length'
    case 'stop_sequence':
      return 'end'
    default:
      return 'end'
  }
}

/** 有状态的协议事件翻译器（index → block 映射，区分 text / tool_use）。 */
class Translator {
  private readonly blocks = new Map<number, { kind: string; id?: string; name?: string }>()
  private stopReason: StopReason = 'end'
  private usageInput = 0
  private usageOutput = 0
  private cacheReadTokens: number | undefined
  private sawUsage = false

  /** 处理单个事件，返回 0+ 个 Delta。 */
  push(e: RawEvent): Delta[] {
    const out: Delta[] = []
    switch (e.type) {
      case 'message_start': {
        const usage = e.message?.usage
        if (usage) {
          this.usageInput = usage.input_tokens ?? 0
          this.usageOutput = usage.output_tokens ?? 0
          if (usage.cache_read_input_tokens != null) this.cacheReadTokens = usage.cache_read_input_tokens
          this.sawUsage = true
        }
        break
      }
      case 'content_block_start': {
        const idx = e.index
        const block = e.content_block
        if (idx == null || !block) break
        if (block.type === 'tool_use') {
          this.blocks.set(idx, { kind: 'tool_use', id: block.id, name: block.name })
          out.push({ type: 'tool_use_start', id: block.id ?? '', name: block.name ?? '' })
        } else {
          this.blocks.set(idx, { kind: block.type })
        }
        break
      }
      case 'content_block_delta': {
        const idx = e.index
        const d = e.delta
        const block = idx == null ? undefined : this.blocks.get(idx)
        if (!d || idx == null) break
        if (d.type === 'text_delta' && d.text != null) {
          out.push({ type: 'text', text: d.text })
        } else if (d.type === 'input_json_delta' && d.partial_json != null && block?.kind === 'tool_use') {
          out.push({ type: 'tool_use_delta', id: block.id ?? '', partial_json: d.partial_json })
        }
        break
      }
      case 'content_block_stop': {
        const idx = e.index
        if (idx == null) break
        const block = this.blocks.get(idx)
        if (block?.kind === 'tool_use' && block.id) {
          out.push({ type: 'tool_use_end', id: block.id })
        }
        this.blocks.delete(idx)
        break
      }
      case 'message_delta': {
        if (e.delta?.stop_reason) this.stopReason = mapStopReason(e.delta.stop_reason)
        // usage 是累积语义（官方文档原话 "cumulative"）：后值覆盖前值，可选字段守卫。
        // 兜住 Astron 等兼容端点——它们 message_start 报 0/0，真值放到 message_delta。
        // （对齐 @anthropic-ai/sdk 0.115+ 与 Vercel AI SDK 的聚合写法。）
        if (e.usage?.output_tokens != null) this.usageOutput = e.usage.output_tokens
        if (e.usage?.input_tokens != null) this.usageInput = e.usage.input_tokens
        if (e.usage?.cache_read_input_tokens != null) this.cacheReadTokens = e.usage.cache_read_input_tokens
        break
      }
      case 'error': {
        out.push({
          type: 'error',
          error: { code: 'STREAM_ERROR', message: e.error?.message ?? '流错误', recoverable: true },
        })
        break
      }
      // message_stop / 其它：无 Delta
    }
    return out
  }

  /** 流结束时补 usage + done。 */
  flush(): Delta[] {
    const out: Delta[] = []
    if (this.sawUsage) {
      out.push({
        type: 'usage',
        input_tokens: this.usageInput,
        output_tokens: this.usageOutput,
        // cache_read_tokens 仅在有值时带上（保持 optional 语义干净）
        ...(this.cacheReadTokens != null ? { cache_read_tokens: this.cacheReadTokens } : {}),
      })
    }
    out.push({ type: 'done', stop_reason: this.stopReason })
    return out
  }
}

/** 把 Anthropic 协议事件序列批量翻译成 Delta（纯函数，便于单测）。 */
export function translateAnthropicStream(events: Iterable<RawEvent>): Delta[] {
  const t = new Translator()
  const out: Delta[] = []
  for (const e of events) out.push(...t.push(e))
  out.push(...t.flush())
  return out
}

/** 规范 Message → Anthropic 协议 messages（规范模型贴近 Anthropic，基本透传）。 */
export function toAnthropicMsgs(messages: Message[]): unknown[] {
  // 规范 content block（TextBlock/ToolUseBlock/ToolResultBlock）字段与 Anthropic 一致
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

/** AnthropicProvider（M1 唯一 Provider 实现；OpenaiProvider 留 M3）。 */
export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic'
  private readonly clients = new Map<string, Anthropic>()

  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const client = this.clients.get(req.name) ?? new Anthropic({ baseURL: req.baseURL, apiKey: req.apiKey })
    if (!this.clients.has(req.name)) this.clients.set(req.name, client)

    const stream = client.messages.stream({
      model: req.model,
      system: req.system,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: toAnthropicMsgs(req.messages) as never,
      tools: req.tools as never,
    })

    // signal 透传：中断时 abort stream（SDK 抛 AbortError，loop 的 try/catch 固化已生成内容）
    if (req.signal) {
      if (req.signal.aborted) stream.abort()
      else req.signal.addEventListener('abort', () => stream.abort(), { once: true })
    }

    const t = new Translator()
    for await (const e of stream as AsyncIterable<RawEvent>) {
      for (const d of t.push(e)) yield d
    }
    for (const d of t.flush()) yield d
  }
}
