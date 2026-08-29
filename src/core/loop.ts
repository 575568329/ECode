/**
 * AgentLoop 主循环（心脏）。
 *
 * 详设 §3.1–§3.4。职责：反复调 provider → 执行工具 → 回喂，直到 LLM 不再要求工具。
 *   - 流式消费 Delta（text/tool_use 拼接/usage/error/done）
 *   - try/finally 固化（无论正常/错误/中断，已生成内容都进 messages + history）
 *   - 工具执行（§3.2）：readonly 并行 / 副作用串行 + AJV 校验 + 确认 + 错误兜底
 *   - 停止判定 + 空 tool_use 防护
 *   - recoverable 错误指数退避重试（§6.3，上限 MAX_RETRIES，避免无限重试；
 *     retryable:false 的客户端错如 400/422 不空转重试，直接终止——errors.toAppError 分类）
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
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'

/** ActivityBar 状态（TUI §4.10）：loop 各阶段同步给 UI。 */
export type ActivityState = 'thinking' | 'tool' | 'retry' | 'idle' | 'aborted'

/** recoverable 错误重试上限 + 指数退避（详设 §6.3；参考 aider retry_delay *= 2） */
const MAX_RETRIES = 3
const BASE_RETRY_MS = 500
const MAX_RETRY_CAP_MS = 8000

/**
 * 会话消息中是否含图片载荷（user 直贴 ImageBlock 或 tool_result 附着 blocks）。
 * 用途：非重试错误终止时的图片毒化出路指引触发条件（2026-08-29 调研拍板）——
 * 图片随消息固化进 history 后，严格端点会每轮拒绝；错误只到用户不到模型，
 * 需给人话逃生口。内容级判定、协议无关，不违反心脏铁律。
 */
function hasImagePayload(messages: Message[]): boolean {
  return messages.some((m) =>
    m.content.some((b) => {
      if (b.type === 'image') return true
      if (b.type === 'tool_result') return b.blocks?.some((blk) => blk.type === 'image') === true
      return false
    }),
  )
}

/** 图片毒化出路指引文案（CC "/compact to remove old images" + codex "remove it and try again" 同思路） */
const IMAGE_POISON_HINT =
  '；会话已含图片输入，若此报错与图片相关，可 /rewind 撤回读图、/compact 压缩清图或 /model 切换模型'

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
  confirm?: (use: ToolUseBlock) => Promise<boolean | string>
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
  /**
   * M11-P7：主循环插话——迭代顶部拉取（iter≥2：首轮输入即 userInput，避免连续双 user）。
   * 返回非空则追加为普通 user Message（落盘/恢复/rewind 零特殊处理）；多条由宿主合并。
   * additive 可选回调（afterTools 同模式，无 feature 分支）；子代理 optsB 不配——插话目标是主循环。
   */
  pollUserInput?: () => string | null
  /**
   * 敏感访问确认通路（安全审阅 P0）：invokeTool 构造 toolCtx 时透传为 confirmSensitive，
   * TuiApp 注入 UI 弹窗；argv 无头模式不传即工具侧 fail-closed。
   * loop 只做数据转发——何时算敏感由工具自判（心脏不特判工具，铁律不破）。
   */
  onSensitiveAccess?: (description: string) => Promise<boolean | string>
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
  // F-21（审阅 P1-5 改判定基准）：耗尽 = 循环条件走完（iter > maxIterations）退出，而非
  // 任一 break。break 各处置 done=true；循环后 !done 才算耗尽——CONTEXT_TOO_LONG 压缩重试
  // 与 empty_tool_use 两个 continue 路径在最后一轮撞上限时不再漏报（此前 exhausted 赋值
  // 位于两个 continue 之后，用户看到「已压缩后重试」但重试永不来且无耗尽提示）
  let done = false
  for (let iter = 1; iter <= opts.maxIterations; iter++) {
    // M11-P7：插话步间注入——迭代顶部拉取（模型消化完上轮工具结果才见插话，非打断流中；
    // 顺序天然在 tool_result→afterTools 回喂之后）
    if (iter >= 2) {
      const queued = opts.pollUserInput?.()
      if (queued !== undefined && queued !== null && queued !== '') {
        // F-35：插话带引导包装（CC wrapCommandText 同款格式）——裸插话会让模型只应插话
        // 丢原任务；包装显式声明「任务执行中的补充」+「结合原任务继续」双指令
        const interjectMsg: Message = {
          role: 'user',
          content: [{
            type: 'text',
            text: `用户在任务执行中发来新消息：\n${queued}\n\n请在完成当前任务的过程中处理上述补充（必要时按其调整做法），随后继续原任务直至完成，不要只回应本条而中断原任务。`,
          }],
        }
        messages.push(interjectMsg)
        opts.history.append(interjectMsg)
      }
    }
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
      // 真实 SDK abort 语义（pty 实测，loop 日志实证）：fetch abort 不抛错——流静默正常收尾
      //（done 缺失/截断），for-await 干净结束。若不兜底会当正常 end 走停止判定：
      // 有 tool_use 时 stop-lying 防御还会继续执行工具=中断失效。signal 已断即权威判中断。
      if (opts.signal?.aborted) stopReason = 'aborted'
    } catch (e) {
      if (streamError === null) streamError = toAppError(e)
      // abort 判定三源：裸 AbortError / Anthropic SDK 手动 abort 抛 APIUserAbortError（name 不同，
      // 错分类成可重试会走退避+假 warn）/ signal 已断（宿主 interrupt——兜底权威判据）
      const isAbort =
        e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError') ? true : opts.signal?.aborted === true
      if (isAbort) {
        stopReason = 'aborted'
        isAborted = true
        opts.logger.debug('loop', 'interrupt_latency_probe', { stage: 'surfaced', iter }) // 诊断插桩
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
        done = true
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
          done = true
          break
        }
        opts.callbacks.onWarn?.('上下文超限，已压缩对话后重试')
        retryCount = 0
        continue
      }
      if (streamError.recoverable) {
        // retryable:false（400/422 等客户端错）：同请求重试必同错，退避重试是纯空转——
        // 直接终止本轮（保留已固化内容，onWarn 告知；与 MAX_RETRIES 耗尽同款温和终止）
        if (streamError.retryable === false) {
          opts.callbacks.onActivity?.('idle')
          opts.callbacks.onWarn?.(`${streamError.message}${hasImagePayload(messages.filter(isMessageLine)) ? IMAGE_POISON_HINT : ''}`)
          opts.logger.warn(
            'provider',
            'no_retry',
            { code: streamError.code, message: streamError.message, retryable: false },
            iter,
          )
          done = true
          break
        }
        // P1-9：回滚本轮半截 assistant（history 已落盘保留作 trace），避免下轮
        //   [user, assistant(半截), assistant(重试)] 连续 assistant → Anthropic 400 重试注定失败
        if (pushedThisRound) messages.pop()
        retryCount += 1
        if (retryCount > MAX_RETRIES) {
          opts.callbacks.onWarn?.(`重试 ${MAX_RETRIES} 次仍失败：${streamError.message}`)
          done = true
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
          done = true
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
      done = true
      break
    }
    if (stopReason === 'length') {
      opts.callbacks.onActivity?.('idle')
      opts.callbacks.onWarn?.('输出被截断（达到 max_tokens），输入"继续"可续写')
      opts.logger.warn('loop', 'max_tokens_truncated', { iter })
      done = true
      break
    }
    if (stopReason === 'content_filter') {
      opts.callbacks.onActivity?.('idle')
      opts.callbacks.onWarn?.('内容被安全过滤')
      opts.logger.warn('loop', 'content_filter', { iter })
      done = true
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
  // F-21（§10.5 拍板-2）：迭代上限耗尽不再静默 return——onWarn 告警（对照 length 截断先例；
  // 用户可输入「继续」开新轮续跑）
  if (!done) {
    opts.callbacks.onWarn?.(`已达到迭代上限（maxIterations=${opts.maxIterations}），本轮提前终止——输入「继续」可接着跑`)
    opts.logger.warn('loop', 'max_iterations_exhausted', { maxIterations: opts.maxIterations })
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

/** timeout_ms 软超时哨兵：resolve 而非 reject——Promise.race 输家的 reject 无人接会成 unhandledRejection */
const TOOL_TIMEOUT = Symbol('tool_timeout')

/**
 * timeout_ms 兑现（安全审阅 P1 死契约修复）：仅工具声明了 timeout_ms 才由循环统一强制——
 * Promise.race 软超时（超时放弃等待，不强杀后台 execute；进程清理由工具自身的 signal/kill 逻辑负责）。
 * 未声明则不设限（bash/task 等长任务自管超时）。finally 清定时器防泄漏。
 */
async function executeWithTimeout(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<{ timedOut: true; timeoutMs: number } | { timedOut: false; result: ToolResult }> {
  if (tool.timeout_ms === undefined) return { timedOut: false, result: await tool.execute(input, ctx) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([
      tool.execute(input, ctx),
      new Promise<typeof TOOL_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TOOL_TIMEOUT), tool.timeout_ms)
      }),
    ])
    return r === TOOL_TIMEOUT ? { timedOut: true, timeoutMs: tool.timeout_ms } : { timedOut: false, result: r }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
    // M12-B2：三类早退（不存在/校验失败/确认拒绝）统一触发 onToolResult——
    // 事件面完整性（宿主 item/completed）依赖；此前静默早退是协议化实测出的回调盲区
    opts.callbacks.onToolResult?.(use.id, use.name, { content: `工具 ${use.name} 不存在`, is_error: true })
    return { type: 'tool_result', tool_use_id: use.id, content: `工具 ${use.name} 不存在`, is_error: true }
  }

  const v = opts.tools.validate(use.name, use.input)
  if (!v.ok) {
    opts.callbacks.onToolResult?.(use.id, use.name, { content: v.error, is_error: true })
    return { type: 'tool_result', tool_use_id: use.id, content: v.error, is_error: true }
  }

  if (!tool.readonly) {
    const confirmed = opts.confirm ? await opts.confirm(use) : true
    if (confirmed !== true) {
      // string=带反馈的拒绝（对标 A1：模型知道为什么被拒，可换方法而非瞎猜）；false=无名取消
      const msg =
        typeof confirmed === 'string'
          ? `用户拒绝了本次操作：${confirmed}`
          : '用户已取消'
      opts.callbacks.onToolResult?.(use.id, use.name, { content: msg, is_error: true })
      return { type: 'tool_result', tool_use_id: use.id, content: msg, is_error: true }
    }
  }

  try {
    // M9-P2：包装透传 use.id 给 onBeforeWrite（快照 meta 的投影锚；纯数据转发，心脏不认识 checkpoint）。
    // 敏感访问确认同层透传（数据非逻辑——何时算敏感由工具自判）
    const ctxForCall: ToolContext = {
      ...opts.toolCtx,
      ...(opts.onSensitiveAccess !== undefined ? { confirmSensitive: opts.onSensitiveAccess } : {}),
      ...(opts.toolCtx.onBeforeWrite !== undefined
        ? {
            onBeforeWrite: async (paths: string[], toolName: string) => {
              await opts.toolCtx.onBeforeWrite?.(paths, toolName, use.id)
            },
          }
        : {}),
    }
    const outcome = await executeWithTimeout(tool, use.input, ctxForCall)
    if (outcome.timedOut) {
      const msg = `工具 ${use.name} 执行超时（${outcome.timeoutMs}ms），本轮已放弃等待（后台可能仍在执行，如需终止请用对应工具的停止机制）`
      opts.callbacks.onToolResult?.(use.id, use.name, { content: msg, is_error: true })
      opts.logger.warn('tool', 'timeout', { id: use.id, name: use.name, timeout_ms: outcome.timeoutMs })
      return { type: 'tool_result', tool_use_id: use.id, content: msg, is_error: true }
    }
    const r = outcome.result
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
