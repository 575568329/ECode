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
 *       streamingText 灰字 + toolEntries
 *       ActivityBar（当前动作）
 *       StatusBar（model/轮数/token/成本）   ← 底部常驻，输入框上方
 *       children（输入区）
 *
 * 第 3 步是纯布局骨架（props 驱动）；状态管理 + TuiProvider + loop 接入留第 6 步。
 * children = 输入区（第 4 步 InputStream 注入）。
 */
interface AppProps {
  model: string
  /** 已构造的历史消息项（进 <Static>） */
  items: ReactNode[]
  /** 当前流式文本（动态区灰字） */
  streamingText: string | null
  /** 当前轮工具调用 */
  toolEntries: ToolCallEntry[]
  /** ActivityBar 状态 */
  activity: ActivityState
  activityText?: string
  /** StatusBar 元信息 */
  iter?: number
  maxIter?: number
  tokens?: number
  cost?: string
  warning?: string
  /** 输入区（第 4 步 InputStream） */
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
  children,
}: AppProps): ReactElement {
  const busy =
    streamingText !== null ||
    activity === 'thinking' ||
    activity === 'tool' ||
    activity === 'retry'
  return (
    <Box flexDirection="column">
      <Conversation items={items} streamingText={streamingText} toolEntries={toolEntries}>
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
