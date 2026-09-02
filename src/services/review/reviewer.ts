/**
 * 任务纠偏审查（2026-09-02 用户拍板）：低级主模型跑常规轮，高级 reviewer 模型
 * 「定时兜底 + 异常信号提前触发」出纠偏卡注入——只审查不接管（KV cache 与执行连续性不破）。
 *
 * 职责边界（对齐 distill.ts 先例）：本文件只做策略判定/上下文构造/LLM 调用与卡格式化
 * （全部可单测纯函数 + 一个薄调用层）；触发接线与注入通道在 HostSession（插话队列/轮首拼接），
 * 心脏（AgentLoop）零改动——模型分级是编排层职责，不违反「loop 永不 if provider」铁律。
 */

import type { LLMProvider, LLMProviderRunRequest, ProviderReq } from '../../providers/interface.js'
import type { Message } from '../../core/types.js'

export const DEFAULT_REVIEW_INTERVAL_TURNS = 5
export const DEFAULT_REVIEW_MIN_TURNS = 3
/** 信号阈值：单轮内连续工具失败次数（模型在绕圈/踩同一坑的最强信号） */
export const REVIEW_SIGNAL_CONSECUTIVE_ERRORS = 2
/** 信号阈值：单轮迭代（工具批）数——超过视为长轮（可能在空转） */
export const REVIEW_SIGNAL_LONG_TURN_ITERATIONS = 12
/** 审查上下文预算：尾部消息条数（控制审查轮 input——审查不需要全量历史） */
export const REVIEW_CONTEXT_MESSAGES = 40
/** 纠偏卡上限字符（reviewer 跑题/长篇时截断——注入是 user 消息，不能喧宾夺主） */
export const REVIEW_CARD_MAX_CHARS = 1200

/** 触发原因（通知文案与注入前缀用） */
export type ReviewTrigger = 'interval' | 'signal'

/**
 * 定时兜底判定（纯函数）：turnCount ≥ minTurns 且整除 interval。
 * 例：minTurns=3/interval=5 → 第 5、10、15…轮末触发（3、4 不触发；minTurns 只是下限闸）。
 */
export function shouldReviewAtTurnEnd(
  turnCount: number,
  opts: { intervalTurns?: number; minTurns?: number },
): boolean {
  const interval = opts.intervalTurns ?? DEFAULT_REVIEW_INTERVAL_TURNS
  const min = opts.minTurns ?? DEFAULT_REVIEW_MIN_TURNS
  if (interval <= 0) return false
  return turnCount >= min && turnCount % interval === 0
}

/** 单轮工具批的最长连续失败段（信号判定输入；纯函数） */
export function longestConsecutiveErrorRun(tools: ReadonlyArray<{ isError: boolean }>): number {
  let best = 0
  let cur = 0
  for (const t of tools) {
    cur = t.isError ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
}

/** 信号判定（纯函数）：连续工具失败 ≥ 阈值 或 单轮迭代过长 */
export function shouldReviewOnSignal(
  consecutiveErrors: number,
  turnIterations: number,
  opts?: { consecutiveErrorThreshold?: number; longTurnThreshold?: number },
): boolean {
  const errThreshold = opts?.consecutiveErrorThreshold ?? REVIEW_SIGNAL_CONSECUTIVE_ERRORS
  const iterThreshold = opts?.longTurnThreshold ?? REVIEW_SIGNAL_LONG_TURN_ITERATIONS
  return consecutiveErrors >= errThreshold || turnIterations >= iterThreshold
}

/** 审查上下文：投影尾部窗口（审查看近期轨迹足够；全量历史既贵又稀释注意力） */
export function buildReviewMessages(messages: ReadonlyArray<Message>, budget = REVIEW_CONTEXT_MESSAGES): Message[] {
  if (messages.length <= budget) return [...messages]
  const tail = messages.slice(-budget)
  // 首条若非 user（如从 assistant 工具调用中截断），补一行任务目标锚——审查者需要知道在干什么
  if (tail[0]?.role !== 'user') {
    const firstUser = messages.find((m) => m.role === 'user')
    if (firstUser !== undefined) return [firstUser, ...tail]
  }
  return tail
}

/** 审查系统提示：只出高置信项（防 reviewer 幻觉把对的纠错），短卡、可执行 */
export const REVIEW_SYSTEM = `你是一个任务审查者。你看到的是一个终端编码 Agent（由较弱的执行模型驱动）的近期对话轨迹。
请审查任务方向与执行质量，输出一张简短的纠偏卡（中文），格式严格如下：

[纠偏审查]
- 方向：正确 | 偏离（一句话原因）
- 已完成：一到两行
- 下一步：最多 3 条可执行建议（每条一行）
- 风险：仅在高置信时列出（没有则省略本行）

要求：只写你高度确信的内容；不确定的猜测宁可不写；总长不超过 300 字。不要复述对话，不要写代码。`

export interface ReviewOutcome {
  /** 格式化后的纠偏卡（注入用） */
  card: string
  usage?: { input: number; output: number; cacheRead?: number; cacheCreation?: number }
}

/**
 * 调用 reviewer（无 tools 单发，流式收全文 + usage——对齐 distill.callLLM 模式，多收 usage
 * 供按 reviewer 模型计价记账）。返回 null=输出为空（reviewer 异常静默，不打断任务）。
 */
export async function callReviewer(
  provider: LLMProvider,
  providerReq: ProviderReq,
  messages: Message[],
  signal?: AbortSignal,
): Promise<ReviewOutcome | null> {
  const req: LLMProviderRunRequest = {
    name: providerReq.name,
    baseURL: providerReq.baseURL,
    apiKey: providerReq.apiKey,
    model: providerReq.model,
    system: REVIEW_SYSTEM,
    messages,
    tools: [],
    ...(signal !== undefined ? { signal } : {}),
  }
  let raw = ''
  let usage: ReviewOutcome['usage']
  for await (const d of provider.run(req)) {
    if (d.type === 'text') raw += d.text
    else if (d.type === 'usage') {
      usage = {
        input: d.input_tokens,
        output: d.output_tokens,
        ...(d.cache_read_tokens != null ? { cacheRead: d.cache_read_tokens } : {}),
        ...(d.cache_creation_tokens != null ? { cacheCreation: d.cache_creation_tokens } : {}),
      }
    } else if (d.type === 'error') {
      throw new Error(`审查 LLM 流内错误: ${d.error.message}`)
    }
  }
  const card = formatReviewCard(raw)
  return card === '' ? null : { card, usage }
}

/** 纠偏卡格式化：剥控制字符（防 ESC 序列进 transcript/UI）、首尾裁剪、超长截断 */
export function formatReviewCard(raw: string, maxChars = REVIEW_CARD_MAX_CHARS): string {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (cleaned === '') return ''
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars)}…（审查卡超长已截断）`
}
