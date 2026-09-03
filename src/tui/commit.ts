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
import { isBoundary, isRewind, isThinking, isMessageLine, type HistoryLine, type Message, type TextBlock, type ToolUseBlock, type ToolResultBlock } from '../core/types.js'
import { stripUntrustedAnsi } from './sanitize.js'
import type { CommittedItem, CommittedToolCall } from './types.js'
// 2026-09-03 机器消息归属根治：CONTINUE_PROMPT 精确过滤与 REVIEW_CARD_MARK 前缀解析已退役
// （改为 Message.meta 结构化分流）；CONTINUE_PROMPT/审查卡标记常量随退役删除。

export function messagesToCommitted(lines: HistoryLine[]): CommittedItem[] {
  const messages = lines.filter((l): l is Message => !isBoundary(l) && !isRewind(l) && !isThinking(l))
  // boundary → 压缩标记插入点（key=boundary 前的 Message 数；value=被摘要条数 tailStartIndex）。
  // UI 显示全量原文（投影分离），标记按原序插入，告知「此处之上的消息已摘要进模型上下文」。
  // rewind（M9-P2）同款：⇺ 回退标记按原序插入（新标记变体必须在此消化，否则进 filter 被当 Message 炸 UI）。
  const boundaryMarks = new Map<number, number>()
  const rewindMarks = new Map<number, number>()
  // 活动流 D4-B：思考行按原序插 item（与 boundary/rewind 同机制——非消息行消化点，B2 接线点②）
  const thinkingMarks = new Map<number, { durMs: number; text: string }>()
  let msgCount = 0
  for (const line of lines) {
    if (isBoundary(line)) boundaryMarks.set(msgCount, line.tailStartIndex)
    else if (isRewind(line)) rewindMarks.set(msgCount, line.seq)
    else if (isThinking(line)) thinkingMarks.set(msgCount, { durMs: line.durMs, text: line.text })
    else msgCount++
  }
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
  for (let i = 0; i <= messages.length; i++) {
    const mark = boundaryMarks.get(i)
    if (mark !== undefined) {
      flush()
      items.push({ kind: 'compacted', id: `c${n++}`, removedCount: mark })
    }
    const rw = rewindMarks.get(i)
    if (rw !== undefined) {
      flush()
      items.push({ kind: 'rewind', id: `r${n++}`, seq: rw })
    }
    const th = thinkingMarks.get(i)
    if (th !== undefined) {
      flush()
      items.push({ kind: 'thinking', id: `th${n++}`, durMs: th.durMs, text: th.text })
    }
    if (i === messages.length) break
    const m = messages[i]
    if (m.role === 'user') {
      // 2026-09-03 机器消息归属根治：按 meta 结构化分流——替代 CONTINUE_PROMPT 精确匹配
      // 与审查卡前缀解析（字符串特征可被内容碰撞，结构化标记不可）
      if (m.meta !== undefined) {
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as TextBlock).text)
          .join('')
        if (m.meta.kind === 'continue') {
          // 续写指令：模型侧需要，UI 不渲染（旧字符串过滤退役）
        } else if (text !== '') {
          flush()
          if (m.meta.kind === 'review-card') {
            items.push({ kind: 'review-card', id: `rv${i}`, chars: text.length })
          } else {
            // task-notify / loop-guard / quality / interject / system-notice → 系统提示行
            // （interject 含用户插话文本——以系统行呈现保真文本，不冒充普通气泡）
            items.push({ kind: 'system-note', id: `sn${i}`, text })
          }
        }
        // tool_result 不生成 item（已配对进 tool-group）——meta 消息恒为纯文本，此处不留口
      } else {
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as TextBlock).text)
          .join('')
        if (text !== '') {
          flush()
          // 输入体验批（2026-08-31）：user 文本全文固化（「锁死」）
          items.push({ kind: 'user', id: `u${i}`, text })
        }
        // tool_result 不生成 item（已配对进 tool-group）
      }
    } else if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'text') {
          flush()
          // 审阅 S1：Static 固化口净化一次（模型文本可回显被读文件内容——OSC 52 覆写剪贴板/
          // OSC 8 链接欺骗直达终端；动态区由 ToolGroupView 渲染口与折叠窗各自承担）
          items.push({ kind: 'assistant-text', id: `a${i}_${n}`, text: stripUntrustedAnsi((b as TextBlock).text) })
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
    if (isMessageLine(m) && m.role === 'assistant') {
      const found = m.content.find(
        (b) => b.type === 'tool_use' && (b as ToolUseBlock).id === id,
      )
      if (found) return found as ToolUseBlock
    }
  }
  return undefined
}
