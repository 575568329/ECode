/**
 * 对话流（最小 Static 方案 + M3 ConfirmPrompt，详设 §7）。
 *
 * 两区模型：Static（历史固化）+ 动态区（当前轮 ①②③ + confirm 弹窗）。
 * confirm 期间（active.confirm 非空）ConfirmPrompt 替代 ③ 流式位（此时流式已停）。
 */
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, Static } from 'ink'
import { ToolGroupView } from './ToolGroupView.js'
import { ConfirmPrompt } from './ConfirmPrompt.js'
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
      // Static 收起固化（用户拍板：发送新对话后历史默认全收起——▸ preview 单行；
      // 看全文在当前轮 Ctrl+O；历史轮全文回看归输出查看器 M14 挂账）
      return <ToolGroupView tools={callsToTools(item.calls)} />
    case 'compacted':
      // M5 压缩点标记：UI 显示全量原文（投影分离），此处告知模型上下文已被摘要
      return (
        <Text dimColor>
          ⇕ 已压缩（上方 {item.removedCount} 条已摘要进上下文，原文仍显示）
        </Text>
      )
    case 'rewind':
      // M9-P2 回退点标记：下方消息不再进模型上下文（投影截断），原文仍显示
      return (
        <Text dimColor>
          ⇺ 已回退至快照点 {item.seq}（此处之后的对话不再进入上下文，原文仍显示）
        </Text>
      )
  }
}

interface ConversationProps {
  committed: CommittedItem[]
  active: ActiveState
  onToggleTool?: () => void
  onConfirm?: () => void
  onCancel?: () => void
  children?: ReactNode
}

export function Conversation({
  committed,
  active,
  onToggleTool,
  onConfirm,
  onCancel,
  children,
}: ConversationProps): ReactElement {
  const toolExpanded = active.tools.some(
    (t) => t.use && active.expandedTools.has(t.use.id),
  )
  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(item: CommittedItem) => (
          <Box key={item.id}>{renderCommitted(item)}</Box>
        )}
      </Static>
      {/* 动态区：当前轮 ①②③ + confirm */}
      {active.userInput !== '' && <FoldedUserInput text={active.userInput} />}
      {active.tools.length > 0 && (
        <ToolGroupView tools={active.tools} expanded={toolExpanded} done={!active.streaming} onToggle={onToggleTool} />
      )}
      {active.confirm ? (
        <ConfirmPrompt state={active.confirm} onConfirm={onConfirm} onCancel={onCancel} />
      ) : (
        active.streamingText !== '' &&
        (active.streaming ? (
          <GrayStreaming text={active.streamingText} />
        ) : (
          <AssistantMessage text={active.streamingText} />
        ))
      )}
      {children}
    </Box>
  )
}
