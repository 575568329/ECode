import type { ReactElement, ReactNode } from 'react'
import { Box, Text } from 'ink'
import { StatusBar } from './StatusBar.js'
import { ShortcutHint } from './ShortcutHint.js'
import { Conversation } from './Conversation.js'
import { ActivityBar } from './ActivityBar.js'
import type { ActivityState } from '../core/loop.js'
import type { ToolCallEntry } from './toolview.js'

/**
 * App 根组件（M2 第 3 步）：布局骨架。
 *
 *   <Conversation>
 *     <Static items={历史消息}>              ← 终端原生 scrollback 顶（滚轮友好）
 *     动态区：
 *       streamingText 灰字 + toolEntries（expandedAll 全展）
 *       ActivityBar（当前动作，输入框上方）
 *       children（输入区）
 *       底行：StatusBar（model/轮数/token） · ShortcutHint（快捷键）
 */
interface AppProps {
  model: string
  items: ReactNode[]
  streamingText: string | null
  toolEntries: ToolCallEntry[]
  activity: ActivityState
  activityText?: string
  iter?: number
  maxIter?: number
  tokens?: number
  cost?: string
  warning?: string
  /** 工具调用全展开（Ctrl+O） */
  expandedAll?: boolean
  children?: ReactNode
}

export function App({
  model,
  items,
  streamingText,
  toolEntries,
  activity,
  activityText,
  iter,
  maxIter,
  tokens,
  cost,
  warning,
  expandedAll,
  children,
}: AppProps): ReactElement {
  const busy =
    streamingText !== null ||
    activity === 'thinking' ||
    activity === 'tool' ||
    activity === 'retry'
  return (
    <Box flexDirection="column">
      <Conversation
        items={items}
        streamingText={streamingText}
        toolEntries={toolEntries}
        expandedAll={expandedAll}
      >
        <ActivityBar state={activity} text={activityText} />
        {children}
        <Box>
          <StatusBar
            model={model}
            iter={iter}
            maxIter={maxIter}
            tokens={tokens}
            cost={cost}
            warning={warning}
          />
          <Text dimColor> · </Text>
          <ShortcutHint context={busy ? 'busy' : 'default'} />
        </Box>
      </Conversation>
    </Box>
  )
}
