import type { ReactElement, ReactNode } from 'react'
import { Box, Text } from 'ink'
import { StatusBar } from './StatusBar.js'
import { ShortcutHint } from './ShortcutHint.js'
import { Conversation } from './Conversation.js'
import { ActivityBar } from './ActivityBar.js'
import type { ActivityState } from '../core/loop.js'
import type { CommittedItem, ActiveState } from './types.js'
import { theme } from './theme.js'

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
  /** MCP 段（StatusBar 透传，M6） */
  mcp?: string
  /** 运行时告警（重试/限流/压缩等）——底部独立第二行渲染并截断（防长消息挤碎状态行） */
  warning?: string
  /** 告警分级着色（M8②：error 红 / warn 黄 / info 蓝；缺省 warn） */
  warningLevel?: 'error' | 'warn' | 'info'
  /** 配置无效/不完整提示（顶部醒目，启动态；区别于 warning 进 StatusBar） */
  banner?: string
  children?: ReactNode
}

/** 告警行宽上限兜底（终端宽度未知/超宽时也截） */
const WARN_FALLBACK_COLS = 100

/**
 * 告警单行化 + 截断：折叠换行/制表为空格（多行消息会破坏底部布局），
 * 超终端宽（stdout.columns，未知用 100 兜底）截断加省略号。导出供测试。
 */
export function flattenWarnLine(s: string, cols: number = process.stdout.columns ?? WARN_FALLBACK_COLS): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ').trim()
  const max = Math.max(20, cols - 4)
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
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
  mcp,
  warning,
  warningLevel,
  banner,
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
      {banner !== undefined && (
        <Box borderStyle="round" borderColor={theme.warn} paddingX={1}>
          <Text color={theme.warn}>⚠ {banner}</Text>
        </Box>
      )}
      <Conversation
        committed={committed}
        active={active}
        onToggleTool={onToggleTool}
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        <ActivityBar state={activity} text={activityText} />
        {children}
        <Box flexDirection="column">
          <Box>
            <StatusBar
              model={model}
              iter={iter}
              maxIter={maxIter}
              tokens={tokens}
              cost={cost}
              mcp={mcp}
            />
            <Text dimColor> · </Text>
            <ShortcutHint context={busy ? 'busy' : 'default'} />
          </Box>
          {warning !== undefined && (
            <Text color={warningLevel === 'error' ? theme.error : warningLevel === 'info' ? theme.info : theme.warn}>
              {warningLevel === 'error' ? '✖' : warningLevel === 'info' ? 'ℹ' : '⚠'} {flattenWarnLine(warning)}
            </Text>
          )}
        </Box>
      </Conversation>
    </Box>
  )
}
