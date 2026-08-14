/**
 * 摘要压缩策略（M5 §3.2，唯一默认策略）。
 *
 * 算法（单一锚定摘要，滚动更新）：
 *   1. 切分：尾部保留 RECENT_BUDGET 原文，头部（旧消息 + 旧工具结果）送摘要
 *   2. 不变量保护：tail 区起点的 tool_result 必带回配对 tool_use（切断对 → API 400）
 *   3. 结构化 prompt（5 段模板）+ <analysis> 草稿剥离；有 previousSummary 则滚动更新
 *   4. 调 LLM 摘要（无 tools），strip <analysis> 留 <summary>
 *   5. 失败降级：返回 compacted:false（编排器不追加 boundary，下轮重试）
 *
 * 多次压缩不是「摘要的摘要」——更新同一个锚定 summary（previousSummary 回喂）。
 */

import type { LLMProviderRunRequest } from '../../providers/interface.js'
import type { Message } from '../../core/types.js'
import type { CompactionStrategy, CompactionContext, CompactionResult } from './strategy.js'

/** 保留区（tail）token 预算：原文保留最近这段，更老的送摘要。 */
const RECENT_BUDGET_TOKENS = 8000

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
## 下一步
1. [立即的下一步]
## 相关文件
- [文件路径: 为什么重要]
规则：精炼要点不要散文；精确保留文件路径/符号/命令/错误串；不要提及压缩过程。`

export class SummarizeStrategy implements CompactionStrategy {
  readonly name = 'summarize'
  readonly cost = 'llm' as const

  shouldRun(ctx: CompactionContext): boolean {
    // summarize 是默认策略，只要 messages 非空就可跑；编排器已按阈值触发
    return ctx.messages.length > 0
  }

  async run(ctx: CompactionContext): Promise<CompactionResult> {
    const { messages, provider, providerReq, previousSummary, tokenCount } = ctx
    if (messages.length === 0) return { compacted: false }

    // 1. 切分：尾部保留 RECENT_BUDGET，确定 tail 起点
    const rawTailStart = splitMessages(messages, RECENT_BUDGET_TOKENS)
    if (rawTailStart === 0) return { compacted: false } // 全在保留区，无需压缩

    // 2. 不变量：调整 tailStart，确保 tail 区无孤立 tool_result（配对 use 必在 tail）
    const tailStartIndex = preserveToolPairs(messages, rawTailStart)
    if (tailStartIndex === 0) return { compacted: false } // 不变量把全部纳入 tail，无法压缩

    const head = messages.slice(0, tailStartIndex)
    if (head.length === 0) return { compacted: false }

    // 3. 构造摘要 prompt（滚动 summary：有 previousSummary 则更新而非重述）
    const system = previousSummary
      ? `${SUMMARY_SYSTEM_PROMPT}\n\n用上述对话更新以下锚定摘要：保留仍成立的细节，删除过时的，合并新事实。\n\n<existing-summary>\n${previousSummary}\n</existing-summary>`
      : SUMMARY_SYSTEM_PROMPT

    // 4. 调 LLM 摘要（head 作对话输入，无 tools）
    const summaryReq: LLMProviderRunRequest = {
      ...providerReq,
      system,
      messages: head,
      tools: [],
    }
    let raw = ''
    try {
      for await (const d of provider.run(summaryReq)) {
        if (d.type === 'text') raw += d.text
        if (d.type === 'error') return { compacted: false } // 摘要流内错误，降级
      }
    } catch {
      return { compacted: false } // 网络/超时等，降级（下轮重试）
    }

    // 5. strip <analysis>，留 <summary>
    const summary = extractSummary(raw) || raw.trim()
    if (!summary) return { compacted: false }

    return { compacted: true, summary, tailStartIndex, preTokens: tokenCount }
  }
}

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
  while (idx > 0) {
    const resultIds = collectToolResultIds(messages[idx])
    if (resultIds.length === 0) break // tail 起点不是 tool_result 消息，无需扩
    const tailUseIds = collectToolUseIds(messages.slice(idx))
    if (resultIds.every((id) => tailUseIds.has(id))) break // 全配对在 tail，OK
    idx-- // 有孤立 tool_result，往前扩（纳入前一条，可能含配对 use）
  }
  return idx
}

/** 从 LLM 输出提取 <summary>...</summary> 内容（strip <analysis> 草稿）。 */
export function extractSummary(raw: string): string {
  const m = raw.match(/<summary>([\s\S]*?)<\/summary>/i)
  return m ? m[1].trim() : ''
}

/** 估算单消息 token（chars/4，各 block 展开计长）。 */
function estimateMessageTokens(msg: Message): number {
  let chars = 0
  for (const block of msg.content) {
    if (block.type === 'text') chars += block.text.length
    else if (block.type === 'tool_use') chars += block.name.length + safeJsonLen(block.input)
    else if (block.type === 'tool_result') chars += block.content.length
  }
  return Math.ceil(chars / 4)
}

function safeJsonLen(input: unknown): number {
  try {
    return JSON.stringify(input ?? '').length
  } catch {
    return String(input).length
  }
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
