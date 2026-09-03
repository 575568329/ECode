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

import { isMessageLine, APPROVAL_TIMEOUT_FEEDBACK, APPROVAL_NO_CHANNEL_FEEDBACK, type MessageMeta } from './types.js'
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
  /** 工具块开始（流式 content_block_start 时机——text 分段的封口信号；D7 补真实 id） */
  onToolStart?: (name: string, id: string) => void
  /** 思考增量（B1：Anthropic 扩展思考；blockIndex 供归约按块配对——心脏纯透传不解析内容） */
  onThinking?: (blockIndex: number, text: string) => void
  /** 思考块结束（时长由宿主侧自算——Delta 只发边界信号） */
  onThinkingEnd?: (blockIndex: number) => void
  /** 工具真正执行前（B1/D9：invokeTool confirm 之后、execute 之前；签名带 input 纯透传，
   *  digest 不在 loop 生成——loop 解析工具语义=心脏对工具特判，破「加新工具心脏零改动」铁律） */
  onToolExecute?: (name: string, id: string, input: unknown) => void
  /** 工具执行完成（带 id，便于并发结果精确配对） */
  onToolResult?: (id: string, name: string, result: ToolResult) => void
  onUsage?: (inputTokens: number, outputTokens: number, cache?: { read?: number; creation?: number }) => void
  onWarn?: (msg: string) => void
  /** error 级告警（UI 常驻不自动消失——「需要用户行动」的场景用这个，如续写耗尽）；
   *  未桥接时消费方应回退 onWarn */
  onError?: (msg: string) => void
  /** ActivityBar 状态同步（各阶段：thinking/tool/retry/idle/aborted） */
  onActivity?: (state: ActivityState, text?: string) => void
  /** 迭代轮数同步（StatusBar 显示 iter/maxIter） */
  onIter?: (iter: number, maxIter: number) => void
  /** 迭代上限耗尽（2026-09-03：子代理据此在 task 返回值标注截断——主循环语义仍是
   *  onWarn「输入继续」，onExhausted 只补结构化信号不替代） */
  onExhausted?: (maxIterations: number) => void
}

export interface LoopRunOptions {
  provider: LLMProvider
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  callbacks: LoopCallbacks
  providerReq: ProviderReq
  /** system 提示词。函数形态=每轮请求时求值（2026-09-03：子代理轮数感知「当前第 N/M 轮」
   *  ——基串前缀稳定保 KV 缓存，动态段恒在尾部）；字符串形态=静态（主循环等既有调用面不变） */
  system: string | (() => string)
  maxIterations: number
  toolCtx: ToolContext
  /** M10-P2b：首条 user 消息的附着块（图片粘贴 ImageBlock；显示层占位符与内容分离） */
  userBlocks?: ContentBlock[]
  /** 机器消息标记（2026-09-03 归属根治 P2-1）：起轮输入的 meta（queue 机器条目透传）——
   *  缺省 undefined=用户消息。宿主经 userMeta 透传，loop 纯数据转发 */
  userMeta?: MessageMeta
  confirm?: (use: ToolUseBlock) => Promise<boolean | string>
  signal?: AbortSignal
  /** M5：每轮 provider.run 前的压缩 hook（投影+压缩+返回子集喂 LLM）。不配则 messages 直接喂。 */
  onBeforeRequest?: (messages: HistoryLine[], trigger?: 'pressure' | 'overflow') => Promise<Message[]>
  /** M5：压缩完成通知 UI（boundary 已追加到 messages，重建 committed） */
  onCompacted?: (messages: HistoryLine[]) => void
  /**
   * M9-P3：轮末质量回喂钩子（onCompacted 同款注入模式）。loop 只透传本轮工具清单
   * （宿主检测编辑成功→跑 lint/test），返回 feedback 则追加为 user 消息——loop 不认识 lint。
   * 2026-09-03 归属根治（方案 §7 最小扩展预案启用）：返回可带 meta——fbMsg 构造时随行标记，
   * 显示层据此不渲染成用户气泡（loop 仍不认识具体来源，纯透传）。
   */
  afterTools?: (
    round: { tools: Array<{ name: string; isError: boolean }> },
  ) => Promise<{ feedback?: string; meta?: MessageMeta } | void>
  /**
   * M11-P7：主循环插话——迭代顶部拉取（iter≥2：首轮输入即 userInput，避免连续双 user）。
   * 返回非空则追加为普通 user Message（落盘/恢复/rewind 零特殊处理）；多条由宿主合并。
   * additive 可选回调（afterTools 同模式，无 feature 分支）；子代理 optsB 不配——插话目标是主循环。
   * 审阅修复（2026-09-02 纠偏审查四角色）：返回对象形态带 kind:'review'（纠偏审查卡）时
   * 走中性审查包装——原统一冒充「用户发来新消息」是归属谎言（审计混淆），且给恶意内容
   * 提供用户声优的注入放大面（执行端恰是最弱的低级模型）。插话参数化既有范畴，心脏无 feature 分支。
   */
  pollUserInput?: () => string | { text: string; kind?: 'review' } | null
  /**
   * 敏感访问确认通路（安全审阅 P0）：invokeTool 构造 toolCtx 时透传为 confirmSensitive，
   * TuiApp 注入 UI 弹窗；argv 无头模式不传即工具侧 fail-closed。
   * loop 只做数据转发——何时算敏感由工具自判（心脏不特判工具，铁律不破）。
   */
  onSensitiveAccess?: (description: string) => Promise<boolean | string>
}

/** signal 中断判定（模块级函数绕 TS 控制流窄化——迭代顶检 break 后，同函数内后续
 *  `signal?.aborted === true` 会被窄化为不可达，但 await 窗口内状态可翻转，真实可达） */
function signalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** max_tokens 续写指令：CC "Resume directly — no apology, no recap" 同语义。
 *  审阅 P2 修正：曾注释称「isMeta 形态 UI 不渲染」——全仓并无 isMeta 机制，实态是
 *  裸 user 消息随会话落盘。UI 侧由 commit.ts 按本常量精确匹配过滤（不渲染成用户气泡），
 *  模型侧照常可见（续写指令本身要进上下文）。导出供 commit.ts 消费。 */
export const CONTINUE_PROMPT =
  '输出已达 max_tokens 上限被截断。请从中断处直接继续输出：不要道歉、不要复述已写内容，必要时把剩余工作拆成更小的步骤分批输出。'

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
      ? lastMsg.meta === undefined && // 审阅 P1-1（归属根治四角色）：meta 消息（预注入通知等）不参与去重——
        // 理论碰撞：用户输入恰等于通知全文时会被吞（防御一行，语义本就只该比对用户消息）
        lastMsg.role === 'user' &&
        lastMsg.content.some((b) => b.type === 'text' && (b as { text?: string }).text === userInput)
      : false
  if (!alreadyUser) {
    // M10-P2b：图片粘贴等附着块（display 分离——userInput 文本仍为占位/说明，blocks 是真内容）
    const userMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: userInput }, ...(opts.userBlocks ?? [])],
      ...(opts.userMeta !== undefined ? { meta: opts.userMeta } : {}),
    }
    messages.push(userMsg)
    opts.history.append(userMsg) // P0-3：初始 user 也要落盘（restore 才完整）
  }

  let retryCount = 0
  // max_tokens 自动续写（对标 CC：上限 3 次；CC MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3）
  const MAX_CONTINUATIONS = 3
  let continuationCount = 0
  // 续写指令（CC "Resume directly — no apology, no recap" 同语义中文化）
  // F-21（审阅 P1-5 改判定基准）：耗尽 = 循环条件走完（iter > maxIterations）退出，而非
  // 任一 break。break 各处置 done=true；循环后 !done 才算耗尽——CONTEXT_TOO_LONG 压缩重试
  // 与 empty_tool_use 两个 continue 路径在最后一轮撞上限时不再漏报（此前 exhausted 赋值
  // 位于两个 continue 之后，用户看到「已压缩后重试」但重试永不来且无耗尽提示）
  let done = false
  for (let iter = 1; iter <= opts.maxIterations; iter++) {
    // Ctrl+C 立即停（用户拍板 2026-09-02）：迭代顶部 signal 硬检查——原协作式退出依赖
    // provider 流/审批收敛等环节自愿响应，审批拒绝回喂后还会起下一迭代（真机实证：
    // interrupt 到达 5 分钟轮不退）。aborted 即静默退（宿主已广播停止帧，此处不再补事件）。
    // 审阅修复：iter>=1（原 >=2 漏掉「interrupt 落在 UserPromptSubmit hook await 期、新轮
    // controller 不知中断已发生」的窗口——首迭代照发一次无效拨号）；正常轮首迭代 signal 恒未断不误伤
    if (signalAborted(opts.signal)) {
      opts.logger.info('loop', 'aborted_at_iter_top', { iter }, iter)
      done = true
      break
    }
    // M11-P7：插话步间注入——迭代顶部拉取（模型消化完上轮工具结果才见插话，非打断流中；
    // 顺序天然在 tool_result→afterTools 回喂之后）
    if (iter >= 2) {
      const queued = opts.pollUserInput?.()
      const qText = typeof queued === 'string' ? queued : queued?.text
      if (qText !== undefined && qText !== null && qText !== '') {
        // F-35：插话带引导包装（CC wrapCommandText 同款格式）——裸插话会让模型只应插话
        // 丢原任务；包装显式声明「任务执行中的补充」+「结合原任务继续」双指令。
        // kind:'review'（纠偏审查卡）走中性审查包装——不冒充用户消息（归属谎言+注入放大面）
        const isReview = queued !== null && typeof queued === 'object' && queued.kind === 'review'
        const interjectMsg: Message = {
          role: 'user',
          content: [{
            type: 'text',
            text: isReview
              ? `${qText}\n\n（以上为审查器自动生成的纠偏摘要，非用户消息——请评估后仅采纳高置信项校正做法，继续当前任务。）`
              : `用户在任务执行中发来新消息：\n${qText}\n\n请在完成当前任务的过程中处理上述补充（必要时按其调整做法），随后继续原任务直至完成，不要只回应本条而中断原任务。`,
          }],
          // 机器消息标记（2026-09-03 归属根治）：插话与审查卡非普通用户气泡，UI 分流样式
          meta: { kind: isReview ? 'review-card' : 'interject' },
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
    // B1：按 block 原序累积（text 在 tool_use_start 封口成独立块——与流内 content blocks 同构，
    // 客户端时间线分段与轮末重建天然一致，审阅协议 P2-2）
    const roundBlocks: ContentBlock[] = []
    const flushText = (): void => {
      if (textBuf !== '') {
        roundBlocks.push({ type: 'text', text: textBuf })
        textBuf = ''
      }
    }
    const newToolUses: ToolUseBlock[] = []
    let sawThinking = false // B1：thinking-only 轮不算空响应（思考也是输出）
    const seenThinkingBlocks = new Set<number>() // R1/P2-1：interleaved 分段封口守卫（每 iter 重置）
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
        system: typeof opts.system === 'function' ? opts.system() : opts.system,
        messages: ctx,
        tools: opts.tools.specs(),
        signal: opts.signal,
      })) {
        // 批1a（2026-09-02）：流内逐 chunk signal 硬检查——provider/SDK 层可能不响应或静默吞
        // abort（真机实证形态），break 是活跃流上唯一及时止损位；break 后 326 行流末兜底判
        // aborted、finally 固化部分产出、453 合成中断占位 tool_result 配对。break 传播链会
        // 自动 abort 底层请求（两 SDK 源码+实验实证：消费者 break → generator return() →
        // SDK finally abort → TCP 断），无需手动关闭面。静默流（零 chunk 挂死）场景由
        // signal 传参修复（openai.ts 第二参）覆盖——那里本检查没有执行机会
        if (signalAborted(opts.signal)) break
        switch (d.type) {
          case 'text':
            textBuf += d.text
            opts.callbacks.onText(d.text)
            break
          case 'thinking':
            sawThinking = true
            // 活动流审阅 R1/P2-1：interleaved thinking（text→thinking→text）时首见新块封口
            // text——与 reducer 侧同步，transcript 分段与客户端时间线同源（不封口则两段黏连）
            if (!seenThinkingBlocks.has(d.blockIndex)) {
              seenThinkingBlocks.add(d.blockIndex)
              flushText()
            }
            opts.callbacks.onThinking?.(d.blockIndex, d.text)
            break
          case 'thinking_end':
            opts.callbacks.onThinkingEnd?.(d.blockIndex)
            break
          case 'tool_use_start':
            // B1：text→tool 边界即封口（分段固化，审阅协议 P2-2）+ 真实 id（D7）
            flushText()
            jsonBuf.set(d.id, { name: d.name, buf: '' })
            opts.callbacks.onToolStart?.(d.name, d.id)
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
              const use: ToolUseBlock = { type: 'tool_use', id: d.id, name: entry.name, input }
              newToolUses.push(use)
              roundBlocks.push(use)
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
      // 批1a 注释修正（2026-09-02 翻案）：openai 线「流静默正常收尾」的真因是 signal 曾传进
      // body 参数从未到达 fetch + openai v7 SDK 吞 AbortError 静默退出（传参已修为第二参）；
      // anthropic 线是抛 APIUserAbortError（下方 catch 三源判定）。流内逐 chunk 检查是第二道
      // 保险，此处流末兜底仍是权威判据：signal 已断即判 aborted——有 tool_use 时 stop-lying
      // 防御才不会继续执行工具=中断失效。
      if (opts.signal?.aborted) stopReason = 'aborted'
    } catch (e) {
      if (streamError === null) streamError = toAppError(e)
      // abort 判定三源：裸 AbortError / Anthropic SDK 手动 abort 抛 APIUserAbortError（name 不同，
      // 错分类成可重试会走退避+假 warn）/ signal 已断（宿主 interrupt——兜底权威判据）
      const isAbort =
        e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError') ? true : signalAborted(opts.signal)
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
      // 固化已生成内容（无论正常/错误/中断，只要本轮产出了东西就保留）——B1：roundBlocks 已按
      // 流内原序含 text/tool_use 交错块（旧「text 前置+tools 后置」的单串拼装退役）
      flushText()
      if (roundBlocks.length > 0) {
        const assistantMsg: Message = { role: 'assistant', content: roundBlocks }
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
          // 额度耗尽走 onError（UI 常驻——按 2026-09-03「中断类提示不 5s 消失」口径：重置前
          // 用户每次输入都该看到为什么不动）；其余客户端错 onWarn 即可。
          // 审阅修复批（P1-1）：onError 未接线方（子代理内循环等）回退 onWarn——防「子代理
          // 撞配额全静默」且 text 非空仍按正常结果返回（loop.ts:541 截断耗尽先例同款写法）
          if (streamError.code === 'QUOTA_EXCEEDED') {
            ;(opts.callbacks.onError ?? opts.callbacks.onWarn)?.(`${streamError.message}——本轮已终止；等窗口重置后再试，或切备用 provider/model`)
          } else {
            opts.callbacks.onWarn?.(`${streamError.message}${hasImagePayload(messages.filter(isMessageLine)) ? IMAGE_POISON_HINT : ''}`)
          }
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
    // 空响应轮防御（2026-08-30 用户报障实机复现）：provider 合法收尾但零 delta 零 tool_use
    //（端点断流/网关截断/模型空 content）——曾静默当正常轮结束，TUI 无任何提示回 idle，
    // 用户观感即「突然停止连思考都不显示」。警告后按轮结束处理：不自动重试（端点真坏会
    // 重试风暴），重试由用户发起。aborted/错误流不在此列（各有专属路径）。
    if (
      stopReason === 'end' && streamError === null &&
      roundBlocks.length === 0 && !sawThinking
    ) {
      opts.callbacks.onWarn?.('模型返回了空响应（本轮零输出——可能是端点断流或网络异常），请重试')
      opts.logger.warn('loop', 'empty_turn', { iter }, iter)
    }
    // M11-P0：stop 谎报防御——部分 provider 报 done stop_reason:'end' 但本轮已有 tool_use
    //（opencode 实证），按 tool_use 继续执行（不终止）；aborted 不在此列（signal 已断，工具不该跑）
    if (stopReason === 'end' && newToolUses.length > 0) {
      opts.logger.warn('loop', 'stop_lying_defense', { iter, toolUses: newToolUses.length }, iter)
    } else if (stopReason === 'end' || stopReason === 'aborted') {
      // 审阅修复（Ctrl+C 立即停三席）：流中中断时 assistant 已固化 tool_use 块（finally 无条件
      // 落盘）——break 前给未配对的补**中断占位 tool_result**（is_error），保持 tool_use/
      // tool_result 恒配对。投影层 repairOrphanToolUses 会剥孤儿（请求不 400），但 transcript
      // 落盘留孤儿是恢复/审计噪音——源头合成比下游修复干净（length 截断剥除是另一形态先例）
      if (stopReason === 'aborted' && newToolUses.length > 0) {
        const abortResultMsg: Message = {
          role: 'user',
          content: newToolUses.map((u) => ({
            type: 'tool_result' as const,
            tool_use_id: u.id,
            content: '用户中断，工具未执行',
            is_error: true,
          })),
        }
        messages.push(abortResultMsg)
        opts.history.append(abortResultMsg)
      }
      opts.callbacks.onActivity?.(stopReason === 'aborted' ? 'aborted' : 'idle')
      opts.logger.info('loop', 'stop', { stopReason, iter })
      done = true
      break
    }
    if (stopReason === 'length') {
      // 自动续写（2026-08-30 对标调研后实施）：CC 同款——半截 assistant 已在 finally 固化，
      // 追加 user meta 续写指令让模型从中断处接着写，上限 MAX_CONTINUATIONS 次；续写期间
      // ActivityBar 保持 thinking（轮未结束）。截断的 tool_use 不执行不回传（harness 教训：
      // 半截 JSON 不安全，且 assistant 的 tool_use 无配对 tool_result 会让下轮请求 400）。
      const truncatedTools = newToolUses.length
      if (truncatedTools > 0) {
        // 从已固化的 assistant 消息里剥掉截断 tool_use 块（只留文本部分），防止下轮 400
        const lastAssistant = [...messages].reverse().find((m): m is Message => 'role' in m && m.role === 'assistant')
        if (lastAssistant !== undefined) {
          ;(lastAssistant as { content: ContentBlock[] }).content = lastAssistant.content.filter(
            (b) => b.type !== 'tool_use',
          )
        }
        newToolUses.length = 0
        opts.callbacks.onWarn?.(`输出被 max_tokens 截断，${truncatedTools} 个未完成的工具调用已丢弃（续写后请重新发起）`)
        opts.logger.warn('loop', 'max_tokens_tool_use_dropped', { count: truncatedTools }, iter)
      }
      if (continuationCount < MAX_CONTINUATIONS) {
        continuationCount += 1
        const continueMsg: Message = {
          role: 'user',
          content: [{ type: 'text', text: CONTINUE_PROMPT }],
          meta: { kind: 'continue' }, // 机器消息标记：UI 不渲染成用户气泡（2026-09-03 归属根治）
        }
        messages.push(continueMsg)
        opts.history.append(continueMsg)
        opts.callbacks.onWarn?.(`输出达到 max_tokens 上限，已自动续写（${continuationCount}/${MAX_CONTINUATIONS}）——建议调大 maxTokens 配置减少截断`)
        opts.logger.warn('loop', 'max_tokens_continue', { iter, continuationCount }, iter)
        continue // 不 done：ActivityBar 维持 thinking，进入下一迭代接着写
      }
      opts.callbacks.onActivity?.('idle')
      // 耗尽=必须用户行动（调配置/拆任务），走常驻 error 通道（warn 12s 过期曾致用户无感知——报障实证）
      ;(opts.callbacks.onError ?? opts.callbacks.onWarn)?.(
        `输出连续 ${MAX_CONTINUATIONS} 次被 max_tokens 截断，已停止自动续写——请调大 maxTokens 配置（建议 32768+）或拆分任务`,
      )
      opts.logger.warn('loop', 'max_tokens_continuations_exhausted', { iter, continuations: continuationCount }, iter)
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
        const fbMsg: Message = {
          role: 'user',
          content: [{ type: 'text', text: fb.feedback }],
          ...(fb.meta !== undefined ? { meta: fb.meta } : {}), // 机器消息标记随行（UI 分流，模型侧不变）
        }
        messages.push(fbMsg)
        opts.history.append(fbMsg)
      }
    }
  }
  // F-21（§10.5 拍板-2）：迭代上限耗尽不再静默 return——onWarn 告警（对照 length 截断先例；
  // 用户可输入「继续」开新轮续跑）
  if (!done) {
    opts.callbacks.onWarn?.(`已达到迭代上限（maxIterations=${opts.maxIterations}），本轮提前终止——输入「继续」可接着跑`)
    opts.callbacks.onExhausted?.(opts.maxIterations)
    opts.logger.warn('loop', 'max_iterations_exhausted', { maxIterations: opts.maxIterations })
  }

  return messages
}

/** 中断占位 tool_result（审阅修复：中断路径 tool_use/tool_result 恒配对——空返回会留下
 *  `user content:[]` 与孤儿 tool_use 落盘，依赖投影层 repair 剥除是下游兜底不是源头治理） */
const abortedResult = (u: ToolUseBlock): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: u.id,
  content: '用户中断，工具未执行',
  is_error: true,
})

/** 工具执行：只读 Promise.all 并行 / 副作用串行（详设 §3.2）。 */
async function executeTools(uses: ToolUseBlock[], opts: LoopRunOptions): Promise<ToolResultBlock[]> {
  // Ctrl+C 立即停：工具批前 signal 硬检查——中断后的批不再执行（原只防流中 abort，批入口无检查），
  // 每个工具给中断占位 result（不执行≠不配对）
  if (signalAborted(opts.signal)) {
    opts.logger.info('loop', 'aborted_before_tools', { count: uses.length })
    return uses.map(abortedResult)
  }
  const results: ToolResultBlock[] = []
  const readonlys = uses.filter((u) => opts.tools.get(u.name)?.readonly)
  const sideEffects = uses.filter((u) => !opts.tools.get(u.name)?.readonly)

  if (readonlys.length > 0) {
    results.push(...(await Promise.all(readonlys.map((u) => invokeTool(u, opts)))))
  }
  for (const u of sideEffects) {
    // 审阅修复（安全席 P1）：批内逐工具 signal 检查——原只查批入口一次，批内剩余副作用工具
    // 在中断后照跑（hostConfirm 的 signal 快拒被 full-access/accept-edits/remember 直放早退
    // 绕过）。剩余工具补中断占位（与批入口同语义）
    if (signalAborted(opts.signal)) {
      opts.logger.info('loop', 'aborted_mid_tools', { remaining: sideEffects.length - sideEffects.indexOf(u) })
      for (const rest of sideEffects.slice(sideEffects.indexOf(u))) results.push(abortedResult(rest))
      break
    }
    results.push(await invokeTool(u, opts))
  }
  return results
}

/** timeout_ms 软超时哨兵：resolve 而非 reject——Promise.race 输家的 reject 无人接会成 unhandledRejection */
const TOOL_TIMEOUT = Symbol('tool_timeout')

/**
 * timeout_ms 兑现（安全审阅 P1 死契约修复）：仅工具声明了 timeout_ms 才由循环统一强制——
 * Promise.race 软超时（超时放弃等待，不强杀后台 execute；进程清理由工具自身的 signal/kill 逻辑负责）。
 * 现存声明方=MCP 工具（adapt 注入）；bash 改输入参数 timeout_ms 自管（超时自杀树，2026-09-03）。
 * finally 清定时器防泄漏。
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
      // string=带反馈的拒绝（对标 A1：模型知道为什么被拒，可换方法而非瞎猜）；false=无名取消；
      // D-T8：审批超时反馈串自带完整语义（无人应答+引导模型决策）——原样透传，不冠「用户拒绝」前缀；
      // 09-03 走查：零可应答客户端 fail-closed 同款透传（原被冠「用户已取消」误导模型）
      const msg =
        typeof confirmed === 'string'
          ? confirmed === APPROVAL_TIMEOUT_FEEDBACK || confirmed === APPROVAL_NO_CHANNEL_FEEDBACK
            ? confirmed
            : `用户拒绝了本次操作：${confirmed}`
          : '用户已取消'
      opts.callbacks.onToolResult?.(use.id, use.name, { content: msg, is_error: true })
      return { type: 'tool_result', tool_use_id: use.id, content: msg, is_error: true }
    }
  }

  // B1/D9：真正执行前通知（confirm 之后——审批挂起/拒绝期不触发；签名带 input 纯透传，
  // digest 由宿主生成，心脏不解析工具语义）
  opts.callbacks.onToolExecute?.(use.name, use.id, use.input)

  try {
    // M9-P2：包装透传 use.id 给 onBeforeWrite（快照 meta 的投影锚；纯数据转发，心脏不认识 checkpoint）。
    // 敏感访问确认同层透传（数据非逻辑——何时算敏感由工具自判）
    const ctxForCall: ToolContext = {
      ...opts.toolCtx,
      // F-39：本条调用 id 直挂 ctx（bash 超限落盘文件名等工具侧用途；此前只经 onBeforeWrite 闭包间接可及）
      toolUseId: use.id,
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
