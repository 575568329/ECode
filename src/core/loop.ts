/**
 * AgentLoop 主循环（心脏）。
 *
 * 详设 §3.1–§3.4。职责：反复调 provider → 执行工具 → 回喂，直到 LLM 不再要求工具。
 *   - 流式消费 Delta（text/tool_use 拼接/usage/error/done）
 *   - try/finally 固化（无论正常/错误/中断，已生成内容都进 messages + history）
 *   - 工具执行（§3.2）：readonly 并行 / 副作用串行 + AJV 校验 + 确认 + 错误兜底
 *   - 停止判定 + 空 tool_use 防护
 *
 * 心脏永不出现 `if provider === 'xxx'`（铁律）—— 只通过 opts.provider.run 调用。
 * tui/history/logger 通过 opts 注入（M2 TUI / M4 HistoryStore 替换 stub，零改 loop）。
 */

import type {
  AppError,
  ContentBlock,
  Message,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js'
import { toAppError, toFatal } from './errors.js'
import type { LLMProvider } from '../providers/interface.js'
import type { ToolContext, ToolRegistry, ToolResult } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'

/** ActivityBar 状态（TUI §4.10）：loop 各阶段同步给 UI。 */
export type ActivityState = 'thinking' | 'tool' | 'retry' | 'idle' | 'aborted'

export interface LoopCallbacks {
  /** 流式 text 增量（M2: streamText 灰字占位） */
  onText: (text: string) => void
  onToolStart?: (name: string) => void
  onToolResult?: (name: string, result: ToolResult) => void
  onUsage?: (inputTokens: number, outputTokens: number) => void
  onWarn?: (msg: string) => void
  /** ActivityBar 状态同步（M2 TUI 注入；各阶段调用：thinking/tool/retry/idle/aborted） */
  onActivity?: (state: ActivityState, text?: string) => void
}

export interface LoopRunOptions {
  provider: LLMProvider
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  callbacks: LoopCallbacks
  /** provider 配置实例（注入 run） */
  providerReq: { name: string; baseURL: string; apiKey: string; model: string }
  system: string
  maxIterations: number
  toolCtx: ToolContext
  /** 副作用工具确认（M2 TUI 注入；M1 默认全确认） */
  confirm?: (use: ToolUseBlock) => Promise<boolean>
  signal?: AbortSignal
}

/**
 * 跑一轮对话（可能内部多轮工具调用）。
 * @param messages 共享状态（会 mutate 并返回）
 * @param userInput 本轮用户输入
 */
export async function runLoop(messages: Message[], userInput: string, opts: LoopRunOptions): Promise<Message[]> {
  // 调用方可能已乐观 push user（TUI 立即显示）；检测避免重复
  const lastMsg = messages.at(-1)
  const alreadyUser =
    lastMsg?.role === 'user' &&
    lastMsg.content.some((b) => b.type === 'text' && (b as { text?: string }).text === userInput)
  if (!alreadyUser) {
    messages.push({ role: 'user', content: [{ type: 'text', text: userInput }] })
  }

  for (let iter = 1; iter <= opts.maxIterations; iter++) {
    opts.callbacks.onActivity?.('thinking')
    const jsonBuf = new Map<string, { name: string; buf: string }>() // tool_use id → 拼接缓冲
    let textBuf = ''
    const newToolUses: ToolUseBlock[] = []
    let stopReason: StopReason = 'end'
    let streamError: AppError | null = null
    let isAborted = false

    try {
      for await (const d of opts.provider.run({
        name: opts.providerReq.name,
        baseURL: opts.providerReq.baseURL,
        apiKey: opts.providerReq.apiKey,
        model: opts.providerReq.model,
        system: opts.system,
        messages,
        tools: opts.tools.specs(),
        signal: opts.signal,
      })) {
        switch (d.type) {
          case 'text':
            textBuf += d.text
            opts.callbacks.onText(d.text)
            break
          case 'tool_use_start':
            jsonBuf.set(d.id, { name: d.name, buf: '' })
            opts.callbacks.onToolStart?.(d.name)
            opts.callbacks.onActivity?.('tool', `调用 ${d.name}...`)
            break
          case 'tool_use_delta': {
            const entry = jsonBuf.get(d.id)
            if (entry) entry.buf += d.partial_json
            break
          }
          case 'tool_use_end': {
            const entry = jsonBuf.get(d.id)
            if (entry) {
              // ★ 流式 JSON 拼接：parse 失败转 __parse_error（后续 AJV 校验失败产 is_error 交 LLM 自纠）
              let input: unknown
              try {
                input = JSON.parse(entry.buf)
              } catch {
                input = { __parse_error: '工具输入 JSON 解析失败' }
              }
              newToolUses.push({ type: 'tool_use', id: d.id, name: entry.name, input })
            }
            break
          }
          case 'usage':
            opts.callbacks.onUsage?.(d.input_tokens, d.output_tokens)
            break
          case 'error':
            streamError = d.error
            break
          case 'done':
            stopReason = d.stop_reason
            break
        }
      }
    } catch (e) {
      // AbortError 或 SDK 抛出的网络异常：同样走 finally 固化
      if (streamError === null) streamError = toAppError(e)
      const isAbort = e instanceof Error && e.name === 'AbortError'
      if (isAbort) {
        stopReason = 'aborted'
        isAborted = true
      }
      if (streamError && !streamError.recoverable && !isAbort) throw streamError
    } finally {
      // ★ 固化已生成内容（无论正常/错误/中断，只要本轮产出了东西就保留）
      const blocks: ContentBlock[] = []
      if (textBuf) blocks.push({ type: 'text', text: textBuf })
      blocks.push(...newToolUses)
      if (blocks.length > 0) {
        messages.push({ role: 'assistant', content: blocks })
        opts.history.append(messages.at(-1)!)
      }
    }

    // 流内错误处理
    if (streamError) {
      // abort 不走 recoverable 重试（避免 abort → retry → abort 死循环）
      if (isAborted) {
        opts.callbacks.onActivity?.('aborted')
        break
      }
      if (streamError.recoverable) {
        opts.callbacks.onActivity?.('retry', streamError.message)
        opts.callbacks.onWarn?.(streamError.message)
        continue
      }
      throw streamError
    }

    // 停止判定
    if (stopReason === 'end' || stopReason === 'aborted') {
      opts.callbacks.onActivity?.(stopReason === 'aborted' ? 'aborted' : 'idle')
      break
    }
    if (stopReason === 'length') {
      opts.callbacks.onActivity?.('idle')
      opts.callbacks.onWarn?.('输出被截断（达到 max_tokens），输入"继续"可续写')
      break
    }
    if (stopReason === 'content_filter') {
      opts.callbacks.onActivity?.('idle')
      opts.callbacks.onWarn?.('内容被安全过滤')
      break
    }
    if (stopReason === 'error') throw toFatal('error')
    // stopReason === 'tool_use' → 执行工具后继续循环

    // ★ 空 tool_use 防护：stop=tool_use 但无工具块时，不执行空工具、不 push 空 user 消息
    if (newToolUses.length === 0) {
      opts.callbacks.onWarn?.('LLM 要求工具调用但未给出工具，跳过本轮')
      continue
    }

    // 工具执行：只读并行 / 副作用串行
    const results = await executeTools(newToolUses, opts)
    messages.push({ role: 'user', content: results })
    opts.history.append(messages.at(-1)!)
  }

  return messages
}

/** 工具执行：只读 Promise.all 并行 / 副作用串行（详设 §3.2）。 */
async function executeTools(uses: ToolUseBlock[], opts: LoopRunOptions): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = []
  const readonlys = uses.filter((u) => opts.tools.get(u.name)?.readonly)
  const sideEffects = uses.filter((u) => !opts.tools.get(u.name)?.readonly)

  if (readonlys.length > 0) {
    results.push(...(await Promise.all(readonlys.map((u) => invokeTool(u, opts)))))
  }
  for (const u of sideEffects) {
    results.push(await invokeTool(u, opts))
  }
  return results
}

/** 执行单个工具：get → AJV 校验 → 副作用确认 → execute，异常二分（fatal 抛 / recoverable 转 is_error）。 */
async function invokeTool(use: ToolUseBlock, opts: LoopRunOptions): Promise<ToolResultBlock> {
  const tool = opts.tools.get(use.name)
  if (!tool) {
    return { type: 'tool_result', tool_use_id: use.id, content: `工具 ${use.name} 不存在`, is_error: true }
  }

  // AJV 校验：不通过根本不进 Tool
  const v = opts.tools.validate(use.name, use.input)
  if (!v.ok) {
    return { type: 'tool_result', tool_use_id: use.id, content: v.error, is_error: true }
  }

  // 副作用工具：人在回路确认（M1 默认全确认）
  if (!tool.readonly) {
    const confirmed = opts.confirm ? await opts.confirm(use) : true
    if (!confirmed) {
      return { type: 'tool_result', tool_use_id: use.id, content: '用户已取消', is_error: true }
    }
  }

  try {
    const r = await tool.execute(use.input, opts.toolCtx)
    opts.callbacks.onToolResult?.(use.name, r)
    return { type: 'tool_result', tool_use_id: use.id, content: r.content, is_error: r.is_error }
  } catch (e) {
    const err = toAppError(e)
    if (!err.recoverable) throw err // fatal → 抛顶层中断 Loop
    return { type: 'tool_result', tool_use_id: use.id, content: err.message, is_error: true }
  }
}
