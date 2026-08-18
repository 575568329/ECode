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

import { isMessageLine } from './types.js'
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
  /** M10-P2b：首条 user 消息的附着块（图片粘贴 ImageBlock；显示层占位符与内容分离） */
  userBlocks?: ContentBlock[]
  confirm?: (use: ToolUseBlock) => Promise<boolean>
  signal?: AbortSignal
  /** M5：每轮 provider.run 前的压缩 hook（投影+压缩+返回子集喂 LLM）。不配则 messages 直接喂。 */
  onBeforeRequest?: (messages: HistoryLine[], trigger?: 'pressure' | 'overflow') => Promise<Message[]>
  /** M5：压缩完成通知 UI（boundary 已追加到 messages，重建 committed） */
  onCompacted?: (messages: HistoryLine[]) => void
  /**
   * M9-P3：轮末质量回喂钩子（onCompacted 同款注入模式）。loop 只透传本轮工具清单
   * （宿主检测编辑成功→跑 lint/test），返回 feedback 则追加为 user 消息——loop 不认识 lint。
   */
  afterTools?: (round: { tools: Array<{ name: string; isError: boolean }> }) => Promise<{ feedback?: string } | void>
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
    lastMsg && isMessageLine(lastMsg)
      ? lastMsg.role === 'user' &&
        lastMsg.content.some((b) => b.type === 'text' && (b as { text?: string }).text === userInput)
      : false
  if (!alreadyUser) {
    // M10-P2b：图片粘贴等附着块（display 分离——userInput 文本仍为占位/说明，blocks 是真内容）
    const userMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: userInput }, ...(opts.userBlocks ?? [])],
    }
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
        : messages.filter(isMessageLine)
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
      // P0-2: CONTEXT_TOO_LONG 不 fatal throw（真实 provider 400 是 throw APIError，非 SSE error delta），
      //   让它落到下方压缩兜底分支；其它 !recoverable 才 fatal throw
      if (streamError && !streamError.recoverable && !isAbort && streamError.code !== 'CONTEXT_TOO_LONG')
        throw streamError
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
        {
          code: streamError.code,
          message: streamError.message,
          recoverable: streamError.recoverable,
          isAborted,
          // 完整原始错误（HTTP 分类的 message 已提炼为人话一行，原文在 context.raw）
          ...(streamError.context !== undefined ? { context: streamError.context } : {}),
        },
        iter,
      )
      // abort 不走 recoverable 重试（避免 abort → retry → abort 死循环）
      if (isAborted) {
        opts.callbacks.onActivity?.('aborted')
        opts.logger.info('loop', 'aborted', { iter }, iter)
        break
      }
      // M5：CONTEXT_TOO_LONG 走压缩兜底（在 recoverable 退避前；P0-2 改为不 fatal throw 后此处可达）
      if (streamError.code === 'CONTEXT_TOO_LONG' && opts.onBeforeRequest) {
        if (pushedThisRound) messages.pop() // 回滚半截 assistant
        const lenBefore = messages.length
        await opts.onBeforeRequest(messages, 'overflow') // 投影派：编排器追加 boundary（hook 内统一调 onCompacted）
        // P1-4: 检查是否真压缩（messages 增长=新 boundary）；未压缩 → 压缩失败，break 不空转到 maxIterations
        if (messages.length === lenBefore) {
          opts.callbacks.onWarn?.('上下文超限且压缩失败，建议 /clear 起新会话')
          break
        }
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
    // M11-P0：stop 谎报防御——部分 provider 报 done stop_reason:'end' 但本轮已有 tool_use
    //（opencode 实证），按 tool_use 继续执行（不终止）；aborted 不在此列（signal 已断，工具不该跑）
    if (stopReason === 'end' && newToolUses.length > 0) {
      opts.logger.warn('loop', 'stop_lying_defense', { iter, toolUses: newToolUses.length }, iter)
    } else if (stopReason === 'end' || stopReason === 'aborted') {
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
    // M9-P3：轮末质量回喂——feedback 作为 user 消息追加（模型下一轮看到自纠；协议上 tool_result
    // 必须配对 tool_use，信息性回喂不能造无主 result，走 user 文本）
    if (opts.afterTools) {
      // 终审 P1-1：executeTools 重排结果（readonlys 先行），按位置配对会错位——按 tool_use_id 配对
      const resultById = new Map(results.map((r) => [r.tool_use_id, r]))
      const fb = await opts.afterTools({
        tools: newToolUses.map((u) => ({ name: u.name, isError: resultById.get(u.id)?.is_error === true })),
      })
      if (fb?.feedback !== undefined && fb.feedback !== '') {
        const fbMsg: Message = { role: 'user', content: [{ type: 'text', text: fb.feedback }] }
        messages.push(fbMsg)
        opts.history.append(fbMsg)
      }
    }
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
    // M9-P2：包装透传 use.id 给 onBeforeWrite（快照 meta 的投影锚；纯数据转发，心脏不认识 checkpoint）
    const ctxForCall = opts.toolCtx.onBeforeWrite
      ? {
          ...opts.toolCtx,
          onBeforeWrite: async (paths: string[], tool: string) => {
            await opts.toolCtx.onBeforeWrite?.(paths, tool, use.id)
          },
        }
      : opts.toolCtx
    const r = await tool.execute(use.input, ctxForCall)
    opts.callbacks.onToolResult?.(use.id, use.name, r)
    opts.logger.info('tool', 'result', {
      id: use.id,
      name: use.name,
      is_error: r.is_error,
      bytes: Buffer.byteLength(r.content, 'utf8') + (r.blocks?.reduce((n, b) => n + b.source.data.length, 0) ?? 0),
    })
    // M10-P0：多模态附着块透传（blocks 从 ToolResult 到 ToolResultBlock，翻译层组装协议形态）
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: r.content,
      is_error: r.is_error,
      ...(r.blocks !== undefined && r.blocks.length > 0 ? { blocks: r.blocks } : {}),
    }
  } catch (e) {
    const err = toAppError(e)
    if (!err.recoverable) throw err
    return { type: 'tool_result', tool_use_id: use.id, content: err.message, is_error: true }
  }
}
