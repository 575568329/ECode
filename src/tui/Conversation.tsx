import type { ReactElement, ReactNode } from 'react'
import { Static, Box, Text } from 'ink'
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
  /** 已完成的消息项（进 <Static>，冻结不可变；TUI 规范 §8） */
  items: ReactNode[]
  /** 当前流式文本（动态区灰字占位）；null/空表示无流式 */
  streamingText: string | null
  /** 当前轮工具调用（动态区：执行中或已完成未 commit） */
  toolEntries: ToolCallEntry[]
  /** 工具调用全展开（Ctrl+O）；true 则所有动态区 ToolCallView 展开 */
  expandedAll?: boolean
  /** 动态区底部（InputStream 等） */
  children?: ReactNode
}

export function Conversation({
  items,
  streamingText,
  toolEntries,
  expandedAll,
  children,
}: ConversationProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(node, i) => <Box key={i}>{node}</Box>}
      </Static>
      <Box flexDirection="column">
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
    </Box>
  )
}
