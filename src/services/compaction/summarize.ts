/**
 * 摘要压缩策略（M5 §3.2，唯一默认策略）。
 *
 * 单次路径（渐进压缩场景，行为不变）：
 *   1. 切分：尾部保留 RECENT_BUDGET 原文，头部送摘要
 *   2. 不变量保护：tail 区起点的 tool_result 必带回配对 tool_use（切断对 → API 400）
 *   3. 结构化 messages 单发 + 5 段模板 + <analysis> 草稿剥离；previousSummary 滚动更新
 *
 * 分批路径（M5 v2：超大 head，如 1M 模型攒出 600k 切到 200k 模型）：
 *   head 超批预算 → map-reduce（调研验证，对齐 opencode/aider 的序列化转写）：
 *     serialize 转写（tool result 截断）→ 按预算组批 → 逐批摘要（400 二分重试）
 *     → 各批摘要 + previousSummary 一次 reduce → 校验
 *   批是「序列化文本副本」——原 messages 只读；tool_use/result 配对、role 交替等
 *   协议约束在文本化后天然消失（每批就是一条 user 消息）。
 *
 * 失败降级：返回 compacted:false（编排器不追加 boundary，下轮重试/熔断）。
 */

import type { LLMProviderRunRequest } from '../../providers/interface.js'
import type { Message } from '../../core/types.js'
import { toAppError } from '../../core/errors.js'
import { SUMMARY_MSG_PREFIX } from '../../core/context.js'
import { estimateTokens, estimateMessageTokens, estimateMessagesTokens } from '../tokenizer.js'
import type { CompactionStrategy, CompactionContext, CompactionResult } from './strategy.js'

/** 保留区（tail）token 预算：原文保留最近这段，更老的送摘要。 */
const RECENT_BUDGET_TOKENS = 8000

/** 序列化时单条 tool result 的字符上限（防大输出打穿批预算；opencode 同款 2000）。 */
export const TOOL_RESULT_MAX_CHARS = 2000

/** 批摘要输出 token 预留（opencode SUMMARY_OUTPUT_TOKENS 同款）。 */
const SUMMARY_OUTPUT_RESERVE = 4096

/** 批预算额外 buffer（估算误差 + 请求结构开销）。 */
const BATCH_BUFFER_TOKENS = 8000

/** 批 system prompt（模板 + 作用域声明）token 预留。 */
const SCOPE_SYSTEM_RESERVE_TOKENS = 1500

/** 批预算下限（窗口太小时钳到安全值，避免退化成几十批）。 */
const MIN_BATCH_TOKENS = 20000

/** 二分重试深度上限（每次减半，4 层 = 预算/16，足够覆盖估算误差）。 */
const MAX_SPLIT_DEPTH = 4

/** 二分下限（字节）：批已小于 1000 token 仍 400 → 不是「太长」问题，不再拆。 */
const MIN_SPLIT_BYTES = 4000

/** 摘要 system prompt（强制结构化 + 草稿剥离）。 */
const SUMMARY_SYSTEM_PROMPT = `只用文本回复，不要调用任何工具。
先在 <analysis> 里按时序分析对话（用户意图、处理方式、关键决策、代码片段、文件名、错误及修复、用户反馈），
再在 <summary> 里按以下结构输出（保持段落顺序，空也保留）：
## 目标
- [用户想完成什么]
## 重要细节
- [约束/偏好/决策及原因/文件路径/函数名/命令/错误信息；无则 (none)]
## 工作状态
### 已完成 / ### 进行中 / ### 受阻
（对话中有 todo 任务清单时，此处必须包含当前清单各项与状态——摘要后旧清单调用不再可见，清单只活在摘要里）
## 下一步
1. [立即的下一步]
## 相关文件
- [文件路径: 为什么重要]
规则：精炼要点不要散文；精确保留文件路径/符号/命令/错误串；不要提及压缩过程。`

/** 滚动锚定前缀（有 previousSummary 时拼进 system）。 */
function anchoredSystem(previousSummary: string): string {
  return `${SUMMARY_SYSTEM_PROMPT}\n\n用上述内容更新以下锚定摘要：保留仍成立的细节，删除过时的，合并新事实。\n\n<existing-summary>\n${previousSummary}\n</existing-summary>`
}

/** 批预算（token，减法语义对齐主流）：window×0.9 − 输出 − buffer − system 预留，钳下限。 */
export function batchBudgetTokens(effectiveWindow: number): number {
  return Math.max(
    MIN_BATCH_TOKENS,
    effectiveWindow - SUMMARY_OUTPUT_RESERVE - BATCH_BUFFER_TOKENS - SCOPE_SYSTEM_RESERVE_TOKENS,
  )
}

export class SummarizeStrategy implements CompactionStrategy {
  readonly name = 'summarize'
  readonly cost = 'llm' as const

  shouldRun(ctx: CompactionContext): boolean {
    // summarize 是默认策略，只要 messages 非空就可跑；编排器已按阈值触发
    return ctx.messages.length > 0
  }

  async run(ctx: CompactionContext): Promise<CompactionResult> {
    const { messages, tokenCount } = ctx
    if (messages.length === 0) return { compacted: false }

    // 1. 切分：尾部保留 RECENT_BUDGET，确定 tail 起点
    const rawTailStart = splitMessages(messages, RECENT_BUDGET_TOKENS)
    if (rawTailStart === 0) return { compacted: false } // 全在保留区，无需压缩

    // 2. 不变量：调整 tailStart，确保 tail 区无孤立 tool_result（配对 use 必在 tail）
    const tailStartIndex = preserveToolPairs(messages, rawTailStart)
    if (tailStartIndex === 0) return { compacted: false } // 不变量把全部纳入 tail，无法压缩

    let head = messages.slice(0, tailStartIndex)
    // 滚动压缩去重：投影 ctx 的 index-0 是上一轮的 summaryMsg（buildContextMessages 构造），
    // previousSummary 又已注入 system prompt——双份表示会让 LLM 困惑并逐次漂移。
    // 剥掉它，head 只含真实对话（旧 tail + 新消息）。
    if (
      previousSummaryPresent(ctx) &&
      head.length > 0 &&
      head[0].role === 'user' &&
      head[0].content[0]?.type === 'text' &&
      head[0].content[0].text.startsWith(SUMMARY_MSG_PREFIX)
    ) {
      head = head.slice(1)
    }
    if (head.length === 0) return { compacted: false } // 无新内容可摘要（head 只有旧 summary），滚动摘要已涵盖

    // 3. head 装得进单次请求 → 结构化单发（渐进压缩，行为不变）；
    //    超批预算 → 分批 map-reduce（跨 model 大落差场景）
    const budget = batchBudgetTokens(ctx.effectiveWindow)
    const summary =
      estimateMessagesTokens(head) <= budget
        ? await this.summarizeSingle(head, ctx)
        : await summarizeInBatches(head, ctx)
    if (summary == null || summary === '') return { compacted: false }

    return { compacted: true, summary, tailStartIndex, preTokens: tokenCount }
  }

  /** 单次路径：结构化 messages 直发（原 M5 行为）。 */
  private async summarizeSingle(head: Message[], ctx: CompactionContext): Promise<string | null> {
    try {
      const system = previousSummaryPresent(ctx) ? anchoredSystem(ctx.previousSummary!) : SUMMARY_SYSTEM_PROMPT
      const raw = await callSummary(ctx, system, head)
      return extractSummary(raw) || raw.trim() || null
    } catch {
      return null // 摘要流错误/网络异常 → 降级（编排器不追加 boundary）
    }
  }
}

// —— 分批路径（map-reduce）—— //

/** 分批主流程：serialize → 组批 → map（含二分重试）→ reduce → 校验。失败返回 null（降级）。 */
async function summarizeInBatches(head: Message[], ctx: CompactionContext): Promise<string | null> {
  try {
    const budgetBytes = batchBudgetTokens(ctx.effectiveWindow) * 4
    const blocks = head.map(serializeMessage)
    const batches = groupBatches(blocks, budgetBytes)
    // map 并行（真机基准 800k/5 批：串行 103s → 并行 58s，无 429）；结果按批序保序，
    // 二分重试在各批内自愈；端点限流（429）会直接 reject → 整次降级下轮重试
    const partials = await Promise.all(
      batches.map((batch, i) => mapBatch(`${scopeDecl(i + 1, batches.length)}\n\n${batch}`, 0, ctx)),
    )
    let summary = await reducePartials(partials, ctx)
    // reduce 后校验：final summary + tail + system 必须装得进新窗口（aider 同款闸）
    if (estimateTokens(summary) + RECENT_BUDGET_TOKENS + SCOPE_SYSTEM_RESERVE_TOKENS > ctx.effectiveWindow) {
      summary = await reducePartials([summary], ctx) // 极端情况：summary 自身再摘一轮
    }
    return summary || null
  } catch {
    return null // 任一批/合并失败 → 整次降级（下轮重试，熔断计数由编排器管）
  }
}

/** 批首作用域声明：告知本段在整体中的位置 + 禁止收尾（调研：比裸序号标记强）。 */
function scopeDecl(i: number, n: number): string {
  return `以下是一次长对话连续转写的第 ${i}/${n} 段，更早的内容不在本段展示。请按时间顺序提取本段中的事实（用户意图、关键决策、文件路径、命令、错误及修复），不要写总结性结尾——对话在本段之后仍继续。`
}

/** map：单批摘要；批 400（CONTEXT_TOO_LONG）→ 对半二分递归重试（仅限「太长」类错误）。 */
async function mapBatch(text: string, depth: number, ctx: CompactionContext): Promise<string> {
  try {
    const raw = await callSummary(ctx, SUMMARY_SYSTEM_PROMPT, [
      { role: 'user', content: [{ type: 'text', text }] },
    ])
    return extractSummary(raw) || raw.trim()
  } catch (e) {
    const canSplit =
      toAppError(e).code === 'CONTEXT_TOO_LONG' &&
      depth < MAX_SPLIT_DEPTH &&
      Buffer.byteLength(text, 'utf8') > MIN_SPLIT_BYTES
    if (!canSplit) throw e
    const [a, b] = splitTextHalf(text)
    const sa = await mapBatch(a, depth + 1, ctx)
    const sb = await mapBatch(b, depth + 1, ctx)
    return `${sa}\n${sb}`
  }
}

/** reduce：各批摘要（时序标号）+ previousSummary 锚定合并为最终摘要。 */
async function reducePartials(partials: string[], ctx: CompactionContext): Promise<string> {
  const system = previousSummaryPresent(ctx) ? anchoredSystem(ctx.previousSummary!) : SUMMARY_SYSTEM_PROMPT
  const text =
    partials.map((s, i) => `【第 ${i + 1} 段（时序）】\n${s}`).join('\n\n') +
    '\n\n以上是同一次对话按时间顺序分段各自的摘要，请合并为一份完整摘要。'
  const raw = await callSummary(ctx, system, [{ role: 'user', content: [{ type: 'text', text }] }])
  return extractSummary(raw) || raw.trim()
}

/** 摘要 LLM 调用公共：无 tools 流式收全文；流内 error delta 抛错（上层分类降级/二分）。 */
async function callSummary(ctx: CompactionContext, system: string, msgs: Message[]): Promise<string> {
  const req: LLMProviderRunRequest = {
    name: ctx.providerReq.name,
    baseURL: ctx.providerReq.baseURL,
    apiKey: ctx.providerReq.apiKey,
    model: ctx.providerReq.model,
    system,
    messages: msgs,
    tools: [],
    ...(ctx.signal ? { signal: ctx.signal } : {}), // P1-5：摘要可中断
  }
  let raw = ''
  for await (const d of ctx.provider.run(req)) {
    if (d.type === 'text') raw += d.text
    if (d.type === 'error') throw new Error(`摘要流内错误: ${d.error.message}`)
  }
  return raw
}

// —— 序列化与切批（纯函数，导出可单测）—— //

/** Message → 转写文本（opencode 风格标签）。tool result 超 TOOL_RESULT_MAX_CHARS 截断。 */
export function serializeMessage(m: Message): string {
  const parts: string[] = []
  for (const b of m.content) {
    if (b.type === 'text') {
      parts.push(`${m.role === 'user' ? '[User]' : '[Assistant]'}: ${b.text}`)
    } else if (b.type === 'tool_use') {
      parts.push(`[Assistant tool call]: ${b.name}(${safeJsonStringify(b.input)})`)
    } else if (b.type === 'image' || b.type === 'document') {
      // M10-P0：多模态占位——base64 不进摘要（几十 KB 编码串只污染）
      parts.push(b.type === 'image' ? '[图片输入]' : '[PDF 输入]')
    } else {
      const tag = b.is_error ? '[Tool error]' : '[Tool result]'
      const media = b.blocks !== undefined ? ` ${b.blocks.map((x) => (x.type === 'image' ? '[图片]' : '[PDF]')).join('')}` : ''
      parts.push(`${tag}: ${truncateMiddle(b.content, TOOL_RESULT_MAX_CHARS)}${media}`)
    }
  }
  return parts.join('\n')
}

/** 头尾各半保留、中间截断（codex 式：命令输出的开头与结尾信息密度最高）。 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return `${text.slice(0, half)}\n[...中间截断，原文 ${text.length} 字符...]\n${text.slice(-half)}`
}

/** 按字节预算把序列化块组批；单块超预算 → 截断到预算内独立成批。 */
export function groupBatches(blocks: string[], budgetBytes: number): string[] {
  const batches: string[] = []
  let cur: string[] = []
  let curBytes = 0
  const flush = (): void => {
    if (cur.length > 0) {
      batches.push(cur.join('\n\n'))
      cur = []
      curBytes = 0
    }
  }
  for (const block of blocks) {
    const b = Buffer.byteLength(block, 'utf8')
    if (b > budgetBytes) {
      flush()
      batches.push(truncateMiddle(block, budgetBytes)) // 超大单块（截断后仍接近整批预算）
      continue
    }
    if (curBytes + b > budgetBytes) flush()
    cur.push(block)
    curBytes += b + 2 // '\n\n' 连接符
  }
  flush()
  return batches
}

/** 文本对半切：优先在 中点附近的换行 处切（对齐消息边界），找不到就腰斩（纯文本允许）。 */
export function splitTextHalf(text: string): [string, string] {
  const mid = Math.floor(text.length / 2)
  let cut = text.indexOf('\n', mid)
  if (cut < 0 || cut > mid + 2000) cut = mid
  return [text.slice(0, cut), text.slice(cut)]
}

// —— 既有纯函数（渐进压缩路径，行为不变）—— //

/**
 * 切分：从后往前累加 token 到预算，确定 tail 起点（head = 要摘要的旧消息）。
 * @returns tailStartIndex（head = messages[0..tailStartIndex)，tail = messages[tailStartIndex..]）
 */
export function splitMessages(messages: Message[], budget: number): number {
  let acc = 0
  let tailStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i])
    // 预算用尽且 tail 已有至少一条 → 停（保证 tail 非空）
    if (acc + t > budget && i < messages.length - 1) break
    acc += t
    tailStart = i
  }
  return tailStart
}

/** 不变量保护：调整 tailStart，确保 tail 区每个 tool_result 的配对 tool_use 都在 tail。
 *  若 tail 起点消息含孤立 tool_result（配对 use 在 head），往前扩到纳入配对 use。 */
export function preserveToolPairs(messages: Message[], tailStart: number): number {
  let idx = tailStart
  // M8 债 #2：tail use-id 集合一次聚合，前扩时增量并入（原每轮 slice 重扫 = O(n²)）
  const tailUseIds = collectToolUseIds(messages.slice(idx))
  while (idx > 0) {
    const resultIds = collectToolResultIds(messages[idx])
    if (resultIds.length === 0) break // tail 起点不是 tool_result 消息，无需扩
    if (resultIds.every((id) => tailUseIds.has(id))) break // 全配对在 tail，OK
    idx-- // 有孤立 tool_result，往前扩（纳入前一条，可能含配对 use）
    for (const id of collectToolUseIds([messages[idx]])) tailUseIds.add(id)
  }
  return idx
}

/** 从 LLM 输出提取 <summary>...</summary> 内容（strip <analysis> 草稿）。 */
export function extractSummary(raw: string): string {
  const m = raw.match(/<summary>([\s\S]*?)<\/summary>/i)
  return m ? m[1].trim() : ''
}

// —— 估算辅助已收敛进 tokenizer.ts（M5 债 #3：estimateTokens/estimateMessageTokens/
//    estimateMessagesTokens 统一导出，summarize 与 skill listing 共用同一口径）—— //

/** 防御性 JSON 序列化（serializeMessage 的 tool_use 转写用）。 */
function safeJsonStringify(input: unknown): string {
  try {
    return JSON.stringify(input ?? '')
  } catch {
    return String(input)
  }
}

function previousSummaryPresent(ctx: CompactionContext): boolean {
  return ctx.previousSummary !== undefined && ctx.previousSummary !== ''
}

function collectToolResultIds(msg: Message): string[] {
  return msg.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
}

function collectToolUseIds(msgs: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'tool_use') ids.add(b.id)
    }
  }
  return ids
}
