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
import type { Delta, Message, StopReason, ToolSpec, ToolResultBlock, TextBlock, ImageBlock, DocumentBlock } from '../core/types.js'

/** OpenAI 流式 chunk（宽松结构，鸭子类型；不硬依赖 SDK 内部类型）。 */
interface OpenaiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
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
 *  端点行为差异（P1-8）：OpenAI 官方 o 系列（o1/o3/o4-mini）支持生效；DeepSeek 等第三方端点通常忽略未知参数；
 *  OpenAI 官方非推理模型（gpt-4o 等）对未知顶层参数可能 400。若此类模型遇 400，config 设 thinking=off。 */
export function thinkingToOpenai(thinking?: ThinkingLevel): Record<string, unknown> {
  if (!thinking || thinking === 'off') return {} // 不传 = 模型默认
  return { reasoning_effort: thinking } // 'low' | 'medium' | 'high'
}

/** 有状态翻译器：累积 tool_calls（按 index），finish_reason='tool_calls' 时发 tool_use_end。 */
class OpenaiTranslator {
  private stopReason: StopReason = 'end'
  private usageInput = 0
  private usageOutput = 0
  private cacheReadTokens: number | undefined
  private sawUsage = false
  /** index → tool 累积（OpenAI 渐进式给 name/id/arguments） */
  private readonly tools = new Map<number, { id: string; name: string; started: boolean }>()
  /** 已发 tool_use_end 的工具 id（P2-9：flush 补发 started 未 end 的，防 length 截断丢工具） */
  private readonly ended = new Set<string>()

  push(chunk: OpenaiChunk): Delta[] {
    const out: Delta[] = []
    const choice = chunk.choices?.[0]

    // usage-only chunk（stream_options.include_usage 的最后 chunk 可能无 choices）
    if (chunk.usage) {
      this.usageInput = chunk.usage.prompt_tokens ?? 0
      this.usageOutput = chunk.usage.completion_tokens ?? 0
      // OpenAI 的 prompt cache 命中数在 prompt_tokens_details.cached_tokens（§4.7）
      if (chunk.usage.prompt_tokens_details?.cached_tokens != null) {
        this.cacheReadTokens = chunk.usage.prompt_tokens_details.cached_tokens
      }
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
          if (e.started && !this.ended.has(e.id)) {
            out.push({ type: 'tool_use_end', id: e.id })
            this.ended.add(e.id)
          }
        }
      }
    }
    return out
  }

  /** 流结束时补 usage + done。P2-9：补发 started 但未 end 的工具（length 截断在 tool_call 中途等）。 */
  flush(): Delta[] {
    const out: Delta[] = []
    for (const e of this.tools.values()) {
      if (e.started && !this.ended.has(e.id)) {
        out.push({ type: 'tool_use_end', id: e.id })
        this.ended.add(e.id)
      }
    }
    if (this.sawUsage) {
      out.push({
        type: 'usage',
        input_tokens: this.usageInput,
        output_tokens: this.usageOutput,
        ...(this.cacheReadTokens != null ? { cache_read_tokens: this.cacheReadTokens } : {}),
      })
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
      const toolResults = m.content.filter((b) => b.type === 'tool_result') as ToolResultBlock[]
      const texts = m.content.filter((b) => b.type === 'text') as TextBlock[]
      const media = m.content.filter((b): b is ImageBlock | DocumentBlock => b.type === 'image' || b.type === 'document')
      // tool_result → 每条独立 { role:'tool', tool_call_id, content }；
      // M10-P0：tool 消息不支持 image/document——blocks 转移至紧随 user 消息（image_url data URI，CCode 同款先例）
      const transferable: Array<ImageBlock | DocumentBlock> = []
      for (const b of toolResults) {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
        if (b.blocks !== undefined) transferable.push(...b.blocks)
      }
      const images = [...media, ...transferable].filter((b): b is ImageBlock => b.type === 'image')
      // document：chat.completions 无对应形态不转移（智谱自有形态验证关卡时核实）；纯 document 消息给占位
      const hasDocumentOnly = texts.length === 0 && images.length === 0 && (media.some((b) => b.type === 'document') || transferable.some((b) => b.type === 'document'))
      const text = texts.map((b) => b.text).join('\n')
      if (images.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
        // 部分兼容端点要求数组首元素为 text——无文本时补占位（image-only 消息）
        parts.push({ type: 'text', text: text !== '' ? text : '(图片输入)' })
        for (const img of images) {
          parts.push({ type: 'image_url', image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } })
        }
        out.push({ role: 'user', content: parts })
      } else if (text !== '') {
        out.push({ role: 'user', content: hasDocumentOnly ? `${text}\n[文档输入：OpenAI 协议不支持 document，已省略]` : text })
      } else if (hasDocumentOnly) {
        out.push({ role: 'user', content: '[文档输入：OpenAI 协议不支持 document，已省略]' })
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
      // P2-10：空 tools 数组不传（部分端点对 tools:[] 报 400）
      ...(req.tools.length > 0 ? { tools: toOpenaiTools(req.tools) } : {}),
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
