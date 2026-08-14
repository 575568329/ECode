/**
 * AgentLoop 主循环（心脏）。
 *
 * 详设 §3.1–§3.4。职责：反复调 provider → 执行工具 → 回喂，直到 LLM 不再要求工具。
 *   - 流式消费 Delta（text/tool_use 拼接/usage/error/done）
 *   - try/finally 固化（无论正常/错误/中断，已生成内容都进 messages + history）
 *   - 工具执行（§3.2）：readonly 并行 / 副作用串行 + AJV 校验 + 确认 + 错误兜底
 *   - 停止判定 + 空 tool_use 防护
 *   - recoverable 错误指数退避重试（§6.3，上限 MAX_RETRIES，避免无限重试）
 *
 * 心脏永不出现 `if provider === 'xxx'`（铁律）—— 只通过 opts.provider.run 调用。
 */

import { isBoundary } from './types.js'
import type {
  AppError,
  ContentBlock,
  HistoryLine,
  Message,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js'
import { toAppError, toFatal } from './errors.js'
import type { LLMProvider, ProviderReq } from '../providers/interface.js'
import type { ToolContext, ToolRegistry, ToolResult } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'

/** ActivityBar 状态（TUI §4.10）：loop 各阶段同步给 UI。 */
export type ActivityState = 'thinking' | 'tool' | 'retry' | 'idle' | 'aborted'

/** recoverable 错误重试上限 + 指数退避（详设 §6.3；参考 aider retry_delay *= 2） */
const MAX_RETRIES = 3
const BASE_RETRY_MS = 500
const MAX_RETRY_CAP_MS = 8000

/** 可被 AbortSignal 中断的 sleep（退避期间用户 Ctrl+C 立即响应，不傻等） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      return reject(e)
    }
    const onAbort = () => {
      clearTimeout(timer)
      const e = new Error('aborted')
      e.name = 'AbortError'
      reject(e)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface LoopCallbacks {
  /** 流式 text 增量（M2: streamText 灰字占位） */
  onText: (text: string) => void
  onToolStart?: (name: string) => void
  /** 工具执行完成（带 id，便于并发结果精确配对） */
  onToolResult?: (id: string, name: string, result: ToolResult) => void
  onUsage?: (inputTokens: number, outputTokens: number, cache?: { read?: number; creation?: number }) => void
  onWarn?: (msg: string) => void
  /** ActivityBar 状态同步（各阶段：thinking/tool/retry/idle/aborted） */
  onActivity?: (state: ActivityState, text?: string) => void
  /** 迭代轮数同步（StatusBar 显示 iter/maxIter） */
  onIter?: (iter: number, maxIter: number) => void
}

export interface LoopRunOptions {
  provider: LLMProvider
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  callbacks: LoopCallbacks
  providerReq: ProviderReq
  system: string
  maxIterations: number
  toolCtx: ToolContext
  confirm?: (use: ToolUseBlock) => Promise<boolean>
  signal?: AbortSignal
  /** M5：每轮 provider.run 前的压缩 hook（投影+压缩+返回子集喂 LLM）。不配则 messages 直接喂。 */
  onBeforeRequest?: (messages: HistoryLine[], trigger?: 'pressure' | 'overflow') => Promise<Message[]>
  /** M5：压缩完成通知 UI（boundary 已追加到 messages，重建 committed） */
  onCompacted?: (messages: HistoryLine[]) => void
}

/**
 * 跑一轮对话（可能内部多轮工具调用）。
 * @param messages 共享状态（会 mutate 并返回）
 * @param userInput 本轮用户输入
 */
export async function runLoop(messages: HistoryLine[], userInput: string, opts: LoopRunOptions): Promise<HistoryLine[]> {
  // 调用方可能已乐观 push user（TUI 立即显示）；检测避免重复
  const lastMsg = messages.at(-1)
  const alreadyUser =
    lastMsg && !isBoundary(lastMsg)
      ? lastMsg.role === 'user' &&
        lastMsg.content.some((b) => b.type === 'text' && (b as { text?: string }).text === userInput)
      : false
  if (!alreadyUser) {
    const userMsg: Message = { role: 'user', content: [{ type: 'text', text: userInput }] }
    messages.push(userMsg)
    opts.history.append(userMsg) // P0-3：初始 user 也要落盘（restore 才完整）
  }

  let retryCount = 0
  for (let iter = 1; iter <= opts.maxIterations; iter++) {
    opts.callbacks.onIter?.(iter, opts.maxIterations)
    opts.callbacks.onActivity?.('thinking')
    opts.logger.info('loop', 'iter_start', { iter, max: opts.maxIterations, model: opts.providerReq.model }, iter)
    const jsonBuf = new Map<string, { name: string; buf: string }>()
    let textBuf = ''
    const newToolUses: ToolUseBlock[] = []
    let stopReason: StopReason = 'end'
    let streamError: AppError | null = null
    let isAborted = false
    let pushedThisRound = false // P1-9：本轮是否固化了 assistant（retry 时回滚用）

    try {
      // M5 投影派：每轮用 onBeforeRequest 拿投影子集喂 LLM（hook 内可能触发压缩→追加 boundary）
      const ctx: Message[] = opts.onBeforeRequest
        ? await opts.onBeforeRequest(messages)
        : messages.filter((m): m is Message => !isBoundary(m))
      opts.logger.debug('provider', 'request', { messageCount: ctx.length, total: messages.length }, iter)
      for await (const d of opts.provider.run({
        ...opts.providerReq,
        system: opts.system,
        messages: ctx,
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
          case 'usage': {
            const cache =
              d.cache_read_tokens != null || d.cache_creation_tokens != null
                ? { read: d.cache_read_tokens, creation: d.cache_creation_tokens }
                : undefined
            opts.callbacks.onUsage?.(d.input_tokens, d.output_tokens, cache)
            opts.logger.debug('provider', 'usage', { input: d.input_tokens, output: d.output_tokens }, iter)
            break
          }
          case 'error':
            streamError = d.error
            break
          case 'done':
            stopReason = d.stop_reason
            break
        }
      }
    } catch (e) {
      if (streamError === null) streamError = toAppError(e)
      const isAbort = e instanceof Error && e.name === 'AbortError'
      if (isAbort) {
        stopReason = 'aborted'
        isAborted = true
      }
      if (streamError && !streamError.recoverable && !isAbort) throw streamError
    } finally {
      // 固化已生成内容（无论正常/错误/中断，只要本轮产出了东西就保留）
      const blocks: ContentBlock[] = []
      if (textBuf) blocks.push({ type: 'text', text: textBuf })
      blocks.push(...newToolUses)
      if (blocks.length > 0) {
        const assistantMsg: Message = { role: 'assistant', content: blocks }
        messages.push(assistantMsg)
        opts.history.append(assistantMsg)
        pushedThisRound = true
      }
    }

    if (!streamError) retryCount = 0
    // 流内错误处理
    if (streamError) {
      opts.logger.error(
        'loop',
        'stream_error',
        { code: streamError.code, message: streamError.message, recoverable: streamError.recoverable, isAborted },
        iter,
      )
      // abort 不走 recoverable 重试（避免 abort → retry → abort 死循环）
      if (isAborted) {
        opts.callbacks.onActivity?.('aborted')
        opts.logger.info('loop', 'aborted', { iter }, iter)
        break
      }
      // M5：CONTEXT_TOO_LONG 走压缩兜底（在 recoverable 退避前，避免被吞；recoverable:false 不重试）
      if (streamError.code === 'CONTEXT_TOO_LONG' && opts.onBeforeRequest) {
        if (pushedThisRound) messages.pop() // 回滚半截 assistant
        await opts.onBeforeRequest(messages, 'overflow') // 投影派：编排器追加 boundary
        opts.onCompacted?.(messages)
        opts.callbacks.onWarn?.('上下文超限，已压缩对话后重试')
        retryCount = 0
        continue
      }
      if (streamError.recoverable) {
        // P1-9：回滚本轮半截 assistant（history 已落盘保留作 trace），避免下轮
        //   [user, assistant(半截), assistant(重试)] 连续 assistant → Anthropic 400 重试注定失败
        if (pushedThisRound) messages.pop()
        retryCount += 1
        if (retryCount > MAX_RETRIES) {
          opts.callbacks.onWarn?.(`重试 ${MAX_RETRIES} 次仍失败：${streamError.message}`)
          break
        }
        const delay = Math.min(BASE_RETRY_MS * 2 ** (retryCount - 1), MAX_RETRY_CAP_MS)
        opts.callbacks.onActivity?.('retry', `${streamError.message}（${retryCount}/${MAX_RETRIES}，等 ${delay}ms）`)
        opts.callbacks.onWarn?.(streamError.message)
        opts.logger.warn(
          'provider',
          'retry',
          { attempt: retryCount, code: streamError.code, backoff_ms: delay },
          iter,
        )
        try {
          await sleep(delay, opts.signal)
        } catch {
          opts.callbacks.onActivity?.('aborted')
          break
        }
        continue
      }
      throw streamError
    }

    // 停止判定
    if (stopReason === 'end' || stopReason === 'aborted') {
      opts.callbacks.onActivity?.(stopReason === 'aborted' ? 'aborted' : 'idle')
      opts.logger.info('loop', 'stop', { stopReason, iter })
      break
    }
    if (stopReason === 'length') {
      opts.callbacks.onActivity?.('idle')
      opts.callbacks.onWarn?.('输出被截断（达到 max_tokens），输入"继续"可续写')
      opts.logger.warn('loop', 'max_tokens_truncated', { iter })
      break
    }
    if (stopReason === 'content_filter') {
      opts.callbacks.onActivity?.('idle')
      opts.callbacks.onWarn?.('内容被安全过滤')
      opts.logger.warn('loop', 'content_filter', { iter })
      break
    }
    if (stopReason === 'error') {
      opts.logger.error('loop', 'fatal_stop', { stopReason }, iter)
      throw toFatal('error')
    }

    // 空 tool_use 防护
    if (newToolUses.length === 0) {
      opts.callbacks.onWarn?.('LLM 要求工具调用但未给出工具，跳过本轮')
      opts.logger.warn('loop', 'empty_tool_use', { iter })
      continue
    }

    // 工具执行：只读并行 / 副作用串行
    const results = await executeTools(newToolUses, opts)
    const resultMsg: Message = { role: 'user', content: results }
    messages.push(resultMsg)
    opts.history.append(resultMsg)
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
  opts.logger.debug('tool', 'invoke', {
    id: use.id,
    name: use.name,
    input: use.input,
    readonly: tool?.readonly,
  })
  if (!tool) {
    return { type: 'tool_result', tool_use_id: use.id, content: `工具 ${use.name} 不存在`, is_error: true }
  }

  const v = opts.tools.validate(use.name, use.input)
  if (!v.ok) {
    return { type: 'tool_result', tool_use_id: use.id, content: v.error, is_error: true }
  }

  if (!tool.readonly) {
    const confirmed = opts.confirm ? await opts.confirm(use) : true
    if (!confirmed) {
      return { type: 'tool_result', tool_use_id: use.id, content: '用户已取消', is_error: true }
    }
  }

  try {
    const r = await tool.execute(use.input, opts.toolCtx)
    opts.callbacks.onToolResult?.(use.id, use.name, r)
    opts.logger.info('tool', 'result', {
      id: use.id,
      name: use.name,
      is_error: r.is_error,
      bytes: Buffer.byteLength(r.content, 'utf8'),
    })
    return { type: 'tool_result', tool_use_id: use.id, content: r.content, is_error: r.is_error }
  } catch (e) {
    const err = toAppError(e)
    if (!err.recoverable) throw err
    return { type: 'tool_result', tool_use_id: use.id, content: err.message, is_error: true }
  }
}
