/**
 * Context 投影（M5 §7.2，投影派核心）。
 *
 * messagesRef 维护全量 HistoryLine[]（含 boundary），loop 每轮调此函数拿投影子集 Message[] 喂 LLM。
 * messagesRef 全量不变，投影是读时变换——压缩只追加 boundary，不删旧消息。
 *
 * 规则：
 *   - 无 boundary → 返回全量 Message（新会话/未压缩）
 *   - 有 boundary → 返回 [summary 消息] + 该 boundary.tailStartIndex 之后的 Message（tail 原文 + 新消息）
 *
 * tailStartIndex 参考系：相对"全量 Message[]（过滤 boundary 后）"，与 summarize 切分一致（自洽）。
 * 多个 boundary 只认最后一个（最新压缩）。
 */

import { isBoundary, isRewind, isMessageLine, type HistoryLine, type Message, type BoundaryLine } from './types.js'

/** 从全量 history lines 投影出喂 LLM 的 context（纯函数，无副作用）。 */
export function buildContextMessages(lines: HistoryLine[]): Message[] {
  // M9-P2：rewind 截断先行——最后一条 rewind 生效，跳过「锚消息..rewind 行」区间：
  // 锚之前的行（回退点）+ rewind 行之后的行（回退后继续聊的新对话）保留，被回退的区间不进上下文。
  // boundary 逻辑在拼接子集上照常跑（区间外的 boundary 原序保留，规则不变）——两标记取最后语义天然共存。
  let subset = lines
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!isRewind(line)) continue
    const toolId = line.toolUseId
    if (toolId === undefined) break // 旧点缺锚：忽略截断（防御）
    const anchorIdx = lines.findIndex(
      (l) => isMessageLine(l) && l.role === 'assistant' && l.content.some((b) => b.type === 'tool_use' && b.id === toolId),
    )
    if (anchorIdx >= 0 && anchorIdx < i) subset = [...lines.slice(0, anchorIdx), ...lines.slice(i + 1)]
    // 锚失联 → 忽略截断，用全量（防御）
    break
  }

  // 找最后一个 boundary（最新压缩的锚点）
  let lastBoundary: BoundaryLine | null = null
  for (let i = subset.length - 1; i >= 0; i--) {
    const line = subset[i]
    if (isBoundary(line)) {
      lastBoundary = line
      break
    }
  }

  // 过滤出 Message[]（去掉标记行）——tailStartIndex 的参考系
  const msgs = subset.filter(isMessageLine)
  if (!lastBoundary) return msgs

  // 有 boundary → [summary 消息] + tailStartIndex 之后的 Message（tail 原文 + 新消息）
  const start = Math.max(0, Math.min(lastBoundary.tailStartIndex, msgs.length)) // P2-14: 双向钳（防负/越界）
  const tail = msgs.slice(start)
  // P1-3: summaryMsg role 避开与 tail[0] 撞同 role（连续 user/assistant → 部分端点 400）
  const summaryRole: Message['role'] = tail.length > 0 && tail[0].role === 'user' ? 'assistant' : 'user'
  const summaryMsg: Message = {
    role: summaryRole,
    content: [{ type: 'text', text: `${SUMMARY_MSG_PREFIX}${lastBoundary.summary}` }],
  }
  return [summaryMsg, ...tail]
}

/** summary 消息的文本前缀（投影时构造；summarize 据此识别并剥掉旧 summary，避免滚动时双重表示）。 */
export const SUMMARY_MSG_PREFIX = '[此前对话已压缩] '
