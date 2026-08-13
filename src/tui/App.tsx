import type { ReactElement, ReactNode } from 'react'
import { Box, Text } from 'ink'
import { StatusBar } from './StatusBar.js'
import { ShortcutHint } from './ShortcutHint.js'
import { Conversation } from './Conversation.js'
import { ActivityBar } from './ActivityBar.js'
import type { ActivityState } from '../core/loop.js'
import type { CommittedItem, ActiveState } from './types.js'

/**
 * App 根组件（最小 Static + M3 ConfirmPrompt）：
 *
 *   <Conversation committed={历史} active={当前轮} onConfirm/onCancel={弹窗}>
 *     <ActivityBar/>
 *     {children}
 *     底行：StatusBar · ShortcutHint
 */
interface AppProps {
  model: string
  committed: CommittedItem[]
  active: ActiveState
  onToggleTool?: () => void
  onConfirm?: () => void
  onCancel?: () => void
  activity: ActivityState
  activityText?: string
  iter?: number
  maxIter?: number
  tokens?: number
  cost?: string
  warning?: string
  children?: ReactNode
}

export function App({
  model,
  committed,
  active,
  onToggleTool,
  onConfirm,
  onCancel,
  activity,
  activityText,
  iter,
  maxIter,
  tokens,
  cost,
  warning,
  children,
}: AppProps): ReactElement {
  const busy =
    active.streamingText !== '' ||
    active.confirm !== null ||
    activity === 'thinking' ||
    activity === 'tool' ||
    activity === 'retry'
  return (
    <Box flexDirection="column">
      <Conversation
        committed={committed}
        active={active}
        onToggleTool={onToggleTool}
        onConfirm={onConfirm}
        onCancel={onCancel}
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
