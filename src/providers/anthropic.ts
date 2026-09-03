/**
 * AnthropicProvider：接 Astron 的 Anthropic 兼容端点（跑 GLM-5.2）。
 *
 * 职责（详设 §2.2）：协议事件 → 统一 Delta 的翻译封在本文件内部。
 *   - translateAnthropicStream：纯函数，批量翻译事件序列（便于单测）
 *   - Translator：有状态翻译器（index → block 映射），run 用它逐事件 yield
 *   - toAnthropicMsgs：规范 Message → Anthropic 协议 messages（结构贴近，基本透传）
 *
 * client 按 name+baseURL+apiKey 组合键缓存（同一凭据复用避免每轮 new；换凭据即换实例）。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, LLMProviderRunRequest, ThinkingLevel } from './interface.js'
import { createStallWatchdog, DEFAULT_STREAM_STALL_MS, signalAborted } from './stallWatchdog.js'
import { shouldContinueAfterStall, stallContinueReq } from './stallContinue.js'
import { DEFAULT_MAX_TOKENS, type Delta, type Message, type StopReason, type ImageBlock, type DocumentBlock } from '../core/types.js'

/** thinking 枚举 → budget_tokens 映射（D9；P0-2 clamp 共用，提常量免散落 P2-1）。 */
const THINKING_BUDGET: Record<Exclude<ThinkingLevel, 'off'>, number> = { low: 2048, medium: 8192, high: 16384 }

/** thinking 枚举 → Anthropic API 对象（D9，GLM/Anthropic 兼容端点格式 {type, budget_tokens}）。 */
export function thinkingToAnthropic(thinking?: ThinkingLevel): Record<string, unknown> {
  if (!thinking || thinking === 'off') return {}
  return { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET[thinking] } }
}

/**
 * 解析最终 max_tokens（P0-2 修复）：Anthropic 要求 max_tokens **严格大于** thinking.budget_tokens
 * （budget 计入 max_tokens——思考+可见文本共享该额度），否则 400。thinking enabled 时 clamp 到
 * budget+1（防 400 的下限保护；对标 CC：默认 32k 下 budget 8192 仅占 1/4，可见文本 ≥24k）；
 * off 时用 config 值或默认。
 */
export function resolveMaxTokens(maxTokens: number | undefined, thinking?: ThinkingLevel): number {
  const budget = !thinking || thinking === 'off' ? undefined : THINKING_BUDGET[thinking]
  return budget !== undefined ? Math.max(maxTokens ?? DEFAULT_MAX_TOKENS, budget + 1) : maxTokens ?? DEFAULT_MAX_TOKENS
}

/** SDK 流式事件的 usage 形状（input/output/cache，各字段都可能缺失）。 */
interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** SDK 流式事件（宽松结构，按 Anthropic 协议；不硬依赖 SDK 内部类型）。 */
interface RawEvent {
  type: string
  index?: number
  message?: { usage?: RawUsage }
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string }
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
    case 'content_filter':
      return 'content_filter'
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
  private cacheCreationTokens: number | undefined
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
          if (usage.cache_creation_input_tokens != null) this.cacheCreationTokens = usage.cache_creation_input_tokens
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
        } else if (d.type === 'thinking_delta' && d.thinking != null && block?.kind === 'thinking') {
          // B1：思考增量（Anthropic 扩展思考）——blockIndex 供归约按块配对（活动流 §4）
          out.push({ type: 'thinking', blockIndex: idx, text: d.thinking })
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
        } else if (block?.kind === 'thinking') {
          // B1：思考块结束（时长由宿主在回调侧算，Delta 只发边界信号）
          out.push({ type: 'thinking_end', blockIndex: idx })
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
        if (e.usage?.cache_creation_input_tokens != null) this.cacheCreationTokens = e.usage.cache_creation_input_tokens
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
        // cache 维度仅在有值时带上（保持 optional 语义干净）
        ...(this.cacheReadTokens != null ? { cache_read_tokens: this.cacheReadTokens } : {}),
        ...(this.cacheCreationTokens != null ? { cache_creation_tokens: this.cacheCreationTokens } : {}),
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
  // M10-P0：tool_result 带 blocks 时 content 组数组（text + image/document——协议原生形态）；
  // user 消息的 ImageBlock/DocumentBlock 形态与协议完全一致，透传即可（内部元信息 _w/_h 需剥）
  const mapped = messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === 'tool_result') {
        if (b.blocks === undefined || b.blocks.length === 0) return b
        return {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          is_error: b.is_error,
          content: [{ type: 'text', text: b.content }, ...b.blocks.map(stripMediaMeta)],
        }
      }
      if (b.type === 'image' || b.type === 'document') return stripMediaMeta(b)
      return b
    }),
  }))
  // 规整：相邻同 role 合并——loop recoverable/超限重试时内存 messages.pop() 但半截 assistant
  // 已落盘（history.append），/history restore 后磁盘出现两条连续 assistant；Anthropic 端点要求
  // role 严格交替，不合并会 400。块顺序保留（前条块在前）；空 content 的消息跳过丢弃。
  // （OpenAI 兼容端点普遍容忍连续同 role，openai provider 不做——协议差异封在各自 provider 内）
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  for (const m of mapped) {
    if (m.content.length === 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && last.role === m.role) {
      last.content.push(...m.content)
    } else {
      out.push({ role: m.role, content: [...m.content] })
    }
  }
  return out
}

/** 剥多模态块的内部元信息（_w/_h 非协议字段）。 */
function stripMediaMeta(b: ImageBlock | DocumentBlock): ImageBlock | DocumentBlock {
  if (b.type !== 'image') return b
  return { type: 'image', source: b.source }
}

/** AnthropicProvider（M1 唯一 Provider 实现；OpenaiProvider 留 M3）。 */
export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic'
  private readonly clients = new Map<string, Anthropic>()

  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    // 缓存键含 baseURL/apiKey（纯内存组合键，不落日志不打印）：/setup·/config 改同名 provider
    // 凭据后若仍按 name 命中，会沿用旧 client 的旧凭据 → 持续 401 直到重启
    const cacheKey = `${req.name}|${req.baseURL}|${req.apiKey}`
    const client = this.clients.get(cacheKey) ?? new Anthropic({ baseURL: req.baseURL, apiKey: req.apiKey })
    if (!this.clients.has(cacheKey)) this.clients.set(cacheKey, client)

    const thinkingField = thinkingToAnthropic(req.thinking)
    const isThinking = (thinkingField.thinking as { type?: string } | undefined)?.type === 'enabled'

    // P0-B 看门狗（方案 §2，openai.ts 同款语义）：零内容性 delta 持续 streamStallMs → 中止流；
    // 仅零产出首次停滞静默重试 1 次；2026-09-03 起纯文本半截走透明续写（stallContinue.ts——
    // 半截固化 assistant 前缀 + user 续写指令，接续非重答无黏连）；二次/结构化 delta 场景
    // → STREAM_STALL error delta（anthropic SDK 把 abort 转 APIUserAbortError 抛出——若不显式
    // 转译会被 loop 误判为用户中断）
    const stallMs = req.streamStallMs ?? DEFAULT_STREAM_STALL_MS
    let continuationsUsed = 0
    let accumulatedText = '' // 跨段累计的半截文本（续写请求的 assistant 前缀 + 续写判定）
    for (let attempt = 0; ; attempt++) {
      if (signalAborted(req.signal)) return
      const wd = createStallWatchdog(req.signal, stallMs)
      let produced = false
      let sawStructured = false // 本段出现过 thinking/tool_use（此类停滞不续写）
      let segmentText = '' // 本段纯文本累计
      const stream = client.messages.stream({
        model: req.model,
        system: req.system,
        max_tokens: resolveMaxTokens(req.maxTokens, req.thinking),
        // P1-7：thinking enabled 时禁自定义 temperature/top_p（Anthropic 扩展思考约束，否则 400）
        ...(isThinking
          ? {}
          : {
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(req.topP !== undefined ? { top_p: req.topP } : {}),
            }),
        ...thinkingField,
        messages: toAnthropicMsgs(stallContinueReq(req, accumulatedText).messages),
        // P2-10：空 tools 数组不传（Anthropic 对 tools:[] 报 400；MVP 恒注册工具但稳健起见）
        ...(req.tools.length > 0 ? { tools: req.tools } : {}),
      } as never)

      // signal 透传：组合 signal（用户 ∪ 停滞）中断时 abort stream（SDK 抛 AbortError/
      // APIUserAbortError，loop 的 try/catch 固化已生成内容；停滞触发时由下方显式转译接管）
      const onAbort = (): void => stream.abort()
      if (wd.signal) {
        if (wd.signal.aborted) stream.abort()
        else wd.signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        const t = new Translator()
        for await (const e of stream as AsyncIterable<RawEvent>) {
          for (const d of t.push(e)) {
            if (d.type === 'text' || d.type === 'thinking' || d.type === 'tool_use_delta') {
              produced = true
              wd.feed() // 喂狗锚点=内容性 delta（ping 事件/空帧不算，防假喂狗）
            }
            if (d.type === 'text') segmentText += d.text
            if (d.type === 'thinking' || d.type === 'tool_use_delta' || d.type === 'tool_use_start') sawStructured = true
            yield d
          }
        }
        if (!wd.fired()) {
          for (const d of t.flush()) yield d
          return // 正常完成（用户中断的 APIUserAbortError 抛出由 catch 原样上抛给 loop 分类）
        }
        // 审阅修复（架构席 P2·二轮）：停滞段已真实消耗的 input token 先补账——
        // flush 只在非停滞路径执行，主段 usage 原浏漏进 stats/成本（M12-P0 同源动机）
        for (const d of t.flush()) {
          if (d.type === 'usage') yield d
        }
        // 停滞 → 落到循环外统一转译
      } catch (e) {
        if (!wd.fired()) throw e // 非看门狗错误（含用户中断的 APIUserAbortError）原样上抛
      } finally {
        // P1-14：流结束（正常/异常/中断）后摘除 abort 监听器，避免长 REPL 累积监听 + 闭包持有的 stream
        if (wd.signal) wd.signal.removeEventListener('abort', onAbort)
        wd.dispose()
      }
      if (signalAborted(req.signal)) return // 中断优先于停滞报错
      accumulatedText += segmentText
      // 零产出首次停滞 → 既有静默重试 1 次（不占续写额度）
      if (!produced && attempt === 0) continue
      // 2026-09-03：纯文本半截 → 透明续写；超限/结构化 delta → 旧 STREAM_STALL 终态
      if (shouldContinueAfterStall({ producedText: accumulatedText, sawStructured, continuationsUsed, userAborted: signalAborted(req.signal) })) {
        continuationsUsed += 1
        continue
      }
      yield {
        type: 'error',
        error: {
          code: 'STREAM_STALL',
          // 文案按「有无产出」分支（attempt 维度已失真——attempt>0 可能是续写段停滞）：
          // 零产出重试后仍死=重试无效；有产出=半截场景（额度耗尽或结构化不续写）
          message: `响应停滞：连续 ${stallMs}ms 无内容性输出${
            produced ? '（本轮已有部分产出，自动续写后仍停滞或不可续写）' : '（已自动重试 1 次仍停滞）'
          }——可重发本轮（建议让 agent 分批写入），或检查端点/网络`,
          recoverable: true,
          retryable: false,
        },
      }
      return
    }
  }
}
