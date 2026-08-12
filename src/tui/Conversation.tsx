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
  /** 动态区底部（InputStream / ActivityBar / StatusBar，第 3/4 步接入） */
  children?: ReactNode
}

/**
 * 对话流协调（M2 方案 B.4 的 render.ts）：
 *
 *   <Static items={已完成消息}>          ← 静态历史区（冻结，走单独 buffer，滚动友好）
 *   <Box flexDirection="column">         ← 动态当前区（每帧重渲染，只这一块）
 *     {streamingText && <GrayStreaming>}   流式期灰字占位
 *     {toolEntries.map(<ToolCallView>)}    当前轮工具
 *     {children}                           输入/状态栏
 *   </Box>
 *
 * 流结束时机：调用方把 streamingText 清空 + 把最终消息 push 进 items（移入 Static）。
 * 推入 Static 的充要条件：本轮所有 tool_use 已 finalize（见 M2 方案 B.4）。
 */
export function Conversation({
  items,
  streamingText,
  toolEntries,
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
          <ToolCallView key={entry.use.id ?? i} entry={entry} />
        ))}
        {children}
      </Box>
    </Box>
  )
}
