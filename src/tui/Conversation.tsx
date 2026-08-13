/**
 * 对话流（最小 Static 方案，详设 2026-08-13）。
 *
 * 两区模型：
 *   <Static items={committed}>  ← 历史轮（固化 scrollback，滚轮友好，永不重绘）
 *   动态区（当前轮 active 分区，每帧重绘）：
 *     ① FoldedUserInput（user message，折叠到 2 行）
 *     ② ToolGroupView（本轮工具合并块，≤4 行，可展开）
 *     ③ GrayStreaming（流式灰字，3 行折叠尾部）
 *     children（ActivityBar / InputStream / 底行）
 *
 * 视觉顺序固定 ①②③（不随 LLM 交替抖动）；commit 时按 message.content 原序进 Static。
 */
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, Static } from 'ink'
import { ToolGroupView } from './ToolGroupView.js'
import { foldStreamText } from './stream.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import type { CommittedItem, ActiveState, ActiveTool, CommittedToolCall } from './types.js'

/** 用户输入折叠上限（P1-A：防粘贴长代码撑爆动态区） */
const USER_INPUT_MAX_LINES = 2

/** 流式灰字占位（commit 前用；超 STREAM_MAX_LINES 行折叠头部） */
export function GrayStreaming({ text }: { text: string }): ReactElement {
  const { lines, folded, total } = foldStreamText(text)
  return (
    <Box flexDirection="column">
      {folded > 0 && <Text dimColor>↑ {folded} 行已折叠（共 {total} 行）</Text>}
      <Text dimColor>{lines.join('\n')}</Text>
    </Box>
  )
}

/** 折叠用户输入到 USER_INPUT_MAX_LINES 行（复用 foldStreamText，P1-A） */
function FoldedUserInput({ text }: { text: string }): ReactElement {
  const { lines, folded, total } = foldStreamText(text, USER_INPUT_MAX_LINES)
  return (
    <Box flexDirection="column" marginTop={1}>
      {folded > 0 && <Text dimColor>↑ {folded} 行已折叠（共 {total} 行）</Text>}
      <UserMessage text={lines.join('\n')} />
    </Box>
  )
}

/** CommittedToolCall[] → ActiveTool[]（Static tool-group 收起态渲染用） */
function callsToTools(calls: CommittedToolCall[]): ActiveTool[] {
  return calls.map((c) => ({
    name: c.use.name,
    use: c.use,
    result: c.result,
    status: c.result.is_error ? ('error' as const) : ('done' as const),
  }))
}

/** 渲染已固化的 CommittedItem（Static 用） */
function renderCommitted(item: CommittedItem): ReactNode {
  switch (item.kind) {
    case 'user':
      return <UserMessage text={item.text} />
    case 'assistant-text':
      return <AssistantMessage text={item.text} />
    case 'tool-group':
      return <ToolGroupView tools={callsToTools(item.calls)} />
  }
}

interface ConversationProps {
  committed: CommittedItem[]
  active: ActiveState
  onToggleTool?: () => void
  children?: ReactNode
}

export function Conversation({ committed, active, onToggleTool, children }: ConversationProps): ReactElement {
  const toolExpanded = active.tools.some((t) => t.use && active.expandedTools.has(t.use.id))
  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(item: CommittedItem) => (
          <Box key={item.id}>{renderCommitted(item)}</Box>
        )}
      </Static>
      {/* 动态区：当前轮 ①②③ */}
      {active.userInput !== '' && <FoldedUserInput text={active.userInput} />}
      {active.tools.length > 0 && (
        <ToolGroupView tools={active.tools} expanded={toolExpanded} onToggle={onToggleTool} />
      )}
      {active.streamingText !== '' && <GrayStreaming text={active.streamingText} />}
      {children}
    </Box>
  )
}
