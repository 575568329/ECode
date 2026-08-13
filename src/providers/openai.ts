/**
 * OpenaiProvider：接 OpenAI 协议端点（DeepSeek / OpenAI 官方 / Moonshot 等）。
 *
 * 职责（详设 §2.2 + M4 §7）：OpenAI 协议事件 → 统一 Delta 的翻译封在本文件内部。
 *   - OpenaiTranslator：有状态翻译器（index → tool 累积），把 chat.completions stream chunk 翻译成 Delta
 *   - toOpenaiMsgs：规范 Message → OpenAI 协议 messages（system 注入首条；tool_use→tool_calls；tool_result→role:tool）
 *   - thinkingToOpenai：thinking 枚举 → reasoning_effort（D9/P0-5）
 *
 * client 按 name 缓存（同一配置实例复用）。
 * 铁律：心脏只按 type 找实现（registry.getByType('openai')），不认识具体厂商。
 */

import OpenAI from 'openai'
import type { LLMProvider, LLMProviderRunRequest, ThinkingLevel } from './interface.js'
import type { Delta, Message, StopReason, ToolSpec } from '../core/types.js'

/** OpenAI 流式 chunk（宽松结构，鸭子类型；不硬依赖 SDK 内部类型）。 */
interface OpenaiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** OpenAI finish_reason → 规范 StopReason。 */
function mapOpenaiStop(r: string): StopReason {
  switch (r) {
    case 'stop':
      return 'end'
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'end'
  }
}

/** thinking 枚举 → OpenAI reasoning_effort（D9/P0-5）。
 *  仅支持 reasoning_effort 的端点（OpenAI o 系列）生效；不支持的端点（DeepSeek 等）
 *  openai SDK/端点忽略未知参数，不报错、不影响运行。 */
export function thinkingToOpenai(thinking?: ThinkingLevel): Record<string, unknown> {
  if (!thinking || thinking === 'off') return {} // 不传 = 模型默认
  return { reasoning_effort: thinking } // 'low' | 'medium' | 'high'
}

/** 有状态翻译器：累积 tool_calls（按 index），finish_reason='tool_calls' 时发 tool_use_end。 */
class OpenaiTranslator {
  private stopReason: StopReason = 'end'
  private usageInput = 0
  private usageOutput = 0
  private sawUsage = false
  /** index → tool 累积（OpenAI 渐进式给 name/id/arguments） */
  private readonly tools = new Map<number, { id: string; name: string; started: boolean }>()

  push(chunk: OpenaiChunk): Delta[] {
    const out: Delta[] = []
    const choice = chunk.choices?.[0]

    // usage-only chunk（stream_options.include_usage 的最后 chunk 可能无 choices）
    if (chunk.usage) {
      this.usageInput = chunk.usage.prompt_tokens ?? 0
      this.usageOutput = chunk.usage.completion_tokens ?? 0
      this.sawUsage = true
    }
    if (!choice) return out

    const delta = choice.delta
    if (delta?.content) {
      out.push({ type: 'text', text: delta.content })
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index
        let entry = this.tools.get(idx)
        if (!entry) {
          entry = { id: '', name: '', started: false }
          this.tools.set(idx, entry)
        }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name = tc.function.name
        // name 出现 → tool_use_start（只发一次；OpenAI 首个 chunk 给 name+id）
        if (entry.name && entry.id && !entry.started) {
          entry.started = true
          out.push({ type: 'tool_use_start', id: entry.id, name: entry.name })
        }
        if (tc.function?.arguments) {
          out.push({ type: 'tool_use_delta', id: entry.id, partial_json: tc.function.arguments })
        }
      }
    }
    if (choice.finish_reason) {
      this.stopReason = mapOpenaiStop(choice.finish_reason)
      // finish_reason='tool_calls' → 所有活跃 tool 发 end（loop 侧解析 JSON 调用工具）
      if (choice.finish_reason === 'tool_calls') {
        for (const e of this.tools.values()) {
          if (e.started) out.push({ type: 'tool_use_end', id: e.id })
        }
      }
    }
    return out
  }

  /** 流结束时补 usage + done。 */
  flush(): Delta[] {
    const out: Delta[] = []
    if (this.sawUsage) {
      out.push({ type: 'usage', input_tokens: this.usageInput, output_tokens: this.usageOutput })
    }
    out.push({ type: 'done', stop_reason: this.stopReason })
    return out
  }
}

/** 规范 Message[] → OpenAI messages（system 注入首条；tool_use→tool_calls；tool_result→role:tool）。 */
export function toOpenaiMsgs(messages: Message[], system: string): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      const toolResults = m.content.filter((b) => b.type === 'tool_result')
      const texts = m.content.filter((b) => b.type === 'text')
      // tool_result → 每条独立 { role:'tool', tool_call_id, content }
      for (const b of toolResults) {
        const tr = b as { tool_use_id: string; content: string; is_error?: boolean }
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content })
      }
      if (texts.length > 0) {
        const text = texts.map((b) => (b as { text: string }).text).join('\n')
        out.push({ role: 'user', content: text })
      }
    } else if (m.role === 'assistant') {
      const toolUses = m.content.filter((b) => b.type === 'tool_use')
      const texts = m.content.filter((b) => b.type === 'text')
      const msg: Record<string, unknown> = { role: 'assistant' }
      if (texts.length > 0) {
        msg.content = texts.map((b) => (b as { text: string }).text).join('')
      }
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => {
          const tu = b as { id: string; name: string; input: unknown }
          return { id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input) } }
        })
      }
      out.push(msg)
    }
  }
  return out
}

/** 规范 ToolSpec[] → OpenAI tools 格式（{ type:'function', function:{ name, description, parameters } }）。 */
function toOpenaiTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

/** 把 OpenAI 协议 chunk 序列批量翻译成 Delta（纯函数，便于单测）。 */
export function translateOpenaiStream(chunks: Iterable<OpenaiChunk>): Delta[] {
  const t = new OpenaiTranslator()
  const out: Delta[] = []
  for (const c of chunks) out.push(...t.push(c))
  out.push(...t.flush())
  return out
}

/** OpenaiProvider（M4 P1-1）。 */
export class OpenaiProvider implements LLMProvider {
  readonly type = 'openai'
  private readonly clients = new Map<string, OpenAI>()

  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const client = this.clients.get(req.name) ?? new OpenAI({ baseURL: req.baseURL, apiKey: req.apiKey })
    if (!this.clients.has(req.name)) this.clients.set(req.name, client)

    const stream = await client.chat.completions.create({
      model: req.model,
      messages: toOpenaiMsgs(req.messages, req.system),
      tools: toOpenaiTools(req.tools),
      stream: true,
      stream_options: { include_usage: true }, // P1-6：否则 final chunk 无 usage
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...thinkingToOpenai(req.thinking), // P0-5：thinking → reasoning_effort
      ...(req.signal ? { signal: req.signal } : {}),
    } as never)

    const t = new OpenaiTranslator()
    for await (const chunk of stream as unknown as AsyncIterable<OpenaiChunk>) {
      for (const d of t.push(chunk)) yield d
    }
    for (const d of t.flush()) yield d
  }
}
