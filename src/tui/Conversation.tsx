import type { ReactElement, ReactNode } from 'react'
import { Box, Text } from 'ink'
import { ToolCallView } from './ToolCallView.js'
import { foldStreamText } from './stream.js'
import type { ToolCallEntry } from './toolview.js'

/**
 * 流式期灰字占位（M2 方案 A：commit 前灰字，commit 后 Markdown 重渲染）。
 * 超过 STREAM_MAX_LINES（5）行时折叠头部、显示尾部 5 行 + 顶部提示折叠行数（§4.12）。
 */
export function GrayStreaming({ text }: { text: string }): ReactElement {
  const { lines, folded, total } = foldStreamText(text)
  return (
    <Box flexDirection="column">
      {folded > 0 && <Text dimColor>↑ {folded} 行已折叠（共 {total} 行）</Text>}
      <Text dimColor>{lines.join('\n')}</Text>
    </Box>
  )
}

interface ConversationProps {
  /** 已完成的消息项（动态区渲染，不用 <Static>——避免 /clear 残留 + resize 异常） */
  items: ReactNode[]
  /** 当前流式文本（动态区灰字占位）；null/空表示无流式 */
  streamingText: string | null
  /** 当前轮工具调用（动态区：执行中或已完成未 commit） */
  toolEntries: ToolCallEntry[]
  /** 工具调用全展开（Ctrl+O）；true 则所有 ToolCallView 展开 */
  expandedAll?: boolean
  /** 动态区底部（InputStream 等） */
  children?: ReactNode
}

/**
 * 对话流（M2 方案 B.4 的 render.ts）：
 *
 * 不用 Ink <Static>（stock Static 写终端 scrollback，/clear 清不掉 + resize 异常 +
 * 已 commit 的 ToolCallView 不可交互）。改为消息全动态区：每帧重绘，/clear 干净、
 * Ctrl+O 全展开（含历史工具）、resize 稳定。代价：长对话每帧重绘性能（M3 用 memo/虚拟化优化）。
 */
export function Conversation({
  items,
  streamingText,
  toolEntries,
  expandedAll,
  children,
}: ConversationProps): ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((node, i) => (
        <Box key={i}>{node}</Box>
      ))}
      {streamingText !== null && streamingText !== '' && <GrayStreaming text={streamingText} />}
      {toolEntries.map((entry, i) => (
        <ToolCallView
          key={entry.use.id ?? i}
          entry={entry}
          expanded={expandedAll ? true : undefined}
        />
      ))}
      {children}
    </Box>
  )
}
