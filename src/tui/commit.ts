/**
 * commit 调度纯逻辑（最小 Static 方案，详设 §5）。
 *
 * messagesToCommitted：从 messages 按 message.content **原序**生成 CommittedItem。
 * - 不继承旧 messagesToItems 的「text 前置、tool 后置」假设（P2-D），保留 text/tool 交错
 * - 连续 tool_use 合并 tool-group（遇 text/user 即 flush）
 * - orphan tool（中断：tool_use 无 tool_result）补「（已中断）」终态（P2-A）
 *
 * findUse：从 messages 按 id 反查 tool_use（onToolResult 时配对 active.tools 用）。
 */
import { isBoundary, type HistoryLine, type Message, type TextBlock, type ToolUseBlock, type ToolResultBlock } from '../core/types.js'
import type { CommittedItem, CommittedToolCall } from './types.js'

export function messagesToCommitted(lines: HistoryLine[]): CommittedItem[] {
  const messages = lines.filter((l): l is Message => !isBoundary(l))
  const items: CommittedItem[] = []
  // 配对 tool_result（在 user message 内）
  const results = new Map<string, ToolResultBlock>()
  for (const m of messages) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          results.set((b as ToolResultBlock).tool_use_id, b as ToolResultBlock)
        }
      }
    }
  }
  // 原序遍历，连续 tool_use 合并 tool-group，遇 text/user 即 flush
  let pending: CommittedToolCall[] = []
  let n = 0
  const flush = () => {
    if (pending.length > 0) {
      items.push({ kind: 'tool-group', id: `g${n++}`, calls: pending })
      pending = []
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as TextBlock).text)
        .join('')
      if (text) {
        flush()
        items.push({ kind: 'user', id: `u${i}`, text })
      }
      // tool_result 不生成 item（已配对进 tool-group）
    } else if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'text') {
          flush()
          items.push({ kind: 'assistant-text', id: `a${i}_${n}`, text: (b as TextBlock).text })
        } else if (b.type === 'tool_use') {
          const tu = b as ToolUseBlock
          const r = results.get(tu.id)
          if (r) {
            pending.push({ use: tu, result: r })
          } else {
            // orphan tool（中断：tool_use 在 messages 但无 tool_result）补终态（P2-A）
            pending.push({
              use: tu,
              result: {
                type: 'tool_result',
                tool_use_id: tu.id,
                content: '（已中断）',
                is_error: true,
              },
            })
          }
        }
      }
    }
  }
  flush()
  return items
}

/** 从 lines 按 id 反查 tool_use（从末尾找 last assistant；跳过 boundary 行）。 */
export function findUse(lines: HistoryLine[], id: string): ToolUseBlock | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]
    if (!isBoundary(m) && m.role === 'assistant') {
      const found = m.content.find(
        (b) => b.type === 'tool_use' && (b as ToolUseBlock).id === id,
      )
      if (found) return found as ToolUseBlock
    }
  }
  return undefined
}
