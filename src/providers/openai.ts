/**
 * OpenaiProvider：接 OpenAI 协议端点（DeepSeek / OpenAI 官方 / Moonshot 等）。
 *
 * 职责（详设 §2.2 + M4 §7）：OpenAI 协议事件 → 统一 Delta 的翻译封在本文件内部。
 *   - OpenaiTranslator：有状态翻译器（index → tool 累积），把 chat.completions stream chunk 翻译成 Delta
 *   - toOpenaiMsgs：规范 Message → OpenAI 协议 messages（system 注入首条；tool_use→tool_calls；tool_result→role:tool）
 *   - thinkingToOpenai：thinking 枚举 → reasoning_effort（D9/P0-5）
 *
 * client 按 name+baseURL+apiKey 组合键缓存（同一凭据复用；换凭据即换实例）。
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
      /** 智谱 GLM 思考流（真机实证：thinking:{type:'enabled'} 时思考走此字段，先于 content） */
      reasoning_content?: string | null
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

/** thinking 枚举 → 思考开关参数（真机实证修正 2026-09-02）。
 *  智谱 GLM（open.bigmodel.cn）：`thinking: {type:'enabled'}` 生效——`reasoning_effort` 被静默
 *  忽略（思考不启用，抓流实证 476 块 reasoning_content vs 仅 24 块 content 对照）；思考强度
 *  档位（low/medium/high）端点无对应参数，统一 enabled。
 *  OpenAI 官方 o 系的 reasoning_effort 兼容挂账（多端点分发按需再加——当前唯一在册端点为智谱）。 */
export function thinkingToOpenai(thinking?: ThinkingLevel): Record<string, unknown> {
  if (!thinking || thinking === 'off') return {} // 不传 = 模型默认
  return { thinking: { type: 'enabled' } }
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
  /** 思考块开合（OpenAI 流无 block 概念：reasoning_content 先行、content/tool 到达即终——blockIndex 恒 0） */
  private thinkingOpen = false

  /** 思考块封口（content/tool_calls/finish 任一到达时——对应 Anthropic content_block_stop 语义） */
  private closeThinking(out: Delta[]): void {
    if (this.thinkingOpen) {
      this.thinkingOpen = false
      out.push({ type: 'thinking_end', blockIndex: 0 })
    }
  }

  push(chunk: OpenaiChunk): Delta[] {
    const out: Delta[] = []
    const choice = chunk.choices?.[0]

    // usage-only chunk（stream_options.include_usage 的最后 chunk 可能无 choices）
    if (chunk.usage) {
      this.usageOutput = chunk.usage.completion_tokens ?? 0
      // OpenAI 的 prompt cache 命中数在 prompt_tokens_details.cached_tokens（§4.7）。
      // 口径对齐（M12-P0 修复）：OpenAI 的 prompt_tokens 语义**含** cached 部分，而 Anthropic 的
      // input_tokens 不含 cache——统一模型里 input 必须是"非缓存输入"，否则四维分开计价时
      // cache 部分被算两遍（input 全价 + cacheRead 单价）
      if (chunk.usage.prompt_tokens_details?.cached_tokens != null) {
        this.cacheReadTokens = chunk.usage.prompt_tokens_details.cached_tokens
        this.usageInput = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - this.cacheReadTokens)
      } else {
        this.usageInput = chunk.usage.prompt_tokens ?? 0
        this.cacheReadTokens = undefined // 审阅 P2-6：多 usage chunk 逐条覆盖——无 cached 字段时清旧值防 stale 组合重复计价
      }
      this.sawUsage = true
    }
    if (!choice) return out

    const delta = choice.delta
    if (delta?.reasoning_content) {
      if (!this.thinkingOpen) this.thinkingOpen = true
      out.push({ type: 'thinking', blockIndex: 0, text: delta.reasoning_content })
    }
    if (delta?.content) {
      this.closeThinking(out)
      out.push({ type: 'text', text: delta.content })
    }
    if (delta?.tool_calls) {
      this.closeThinking(out)
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
      this.closeThinking(out)
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
      // 审阅 P2：texts/toolUses 均空（续写剥除后/异常历史）产出裸 `{role:'assistant'}`
      // 严格 OpenAI 兼容端点会 400——与 anthropic 翻译层的空 content continue 同口径，跳过
      if (texts.length === 0 && toolUses.length === 0) continue
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
    // 缓存键含 baseURL/apiKey（纯内存组合键，不落日志不打印）：改同名 provider 凭据后
    // 若仍按 name 命中，会沿用旧 client 的旧凭据 → 持续 401 直到重启（anthropic.ts 同款）
    const cacheKey = `${req.name}|${req.baseURL}|${req.apiKey}`
    const client = this.clients.get(cacheKey) ?? new OpenAI({ baseURL: req.baseURL, apiKey: req.apiKey })
    if (!this.clients.has(cacheKey)) this.clients.set(cacheKey, client)

    // 2026-09-02 批1a（四角色审阅 P0-1 翻案）：signal 必须传 create() **第二参** RequestOptions——
    // v7 create(body, options) 不认 body 里的 signal（曾混进 body 形参：signal 从未到达 fetch，
    // 还以 "signal":{} 污染请求体 JSON；Ctrl+C 34-54s 不收敛的真根因。对照实验：传对位置
    // abort 后 4ms 断流断 TCP，静默流挂死场景也随之解除）
    const stream = await client.chat.completions.create(
      {
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
      } as never,
      req.signal ? { signal: req.signal } : {},
    )

    const t = new OpenaiTranslator()
    for await (const chunk of stream as unknown as AsyncIterable<OpenaiChunk>) {
      for (const d of t.push(chunk)) yield d
    }
    for (const d of t.flush()) yield d
  }
}
