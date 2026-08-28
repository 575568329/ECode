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
  /** M9-P4：沙箱模式段（StatusBar 透传；default 不显示） */
  sandbox?: string
  /** full-access 危险色 */
  sandboxDanger?: boolean
  /** 运行时告警（重试/限流/压缩等）——底部独立第二行渲染并截断（防长消息挤碎状态行） */
  warning?: string
  /** 审阅 P1-1：条件段活跃态（TasksBar/SubagentBar——Conversation 总分配显式扣减） */
  conditions?: { tasksBar?: boolean; subagentBar?: boolean }
  /** 告警分级着色（M8②：error 红 / warn 黄 / info 蓝；缺省 warn） */
  warningLevel?: 'error' | 'warn' | 'info'
  /** 配置无效/不完整提示（顶部醒目，启动态；区别于 warning 进 StatusBar） */
  banner?: string
  /** 运行态镜像（thread/status 驱动）——ShortcutHint 上下文权威判据；
   *  缺省回退旧启发式（active.streamingText/activity——测试/旧用法兼容） */
  running?: boolean
  /** 批2b ①②：审批卡字符转发主输入框 + 草稿镜像（Conversation→ConfirmPrompt 透传） */
  onDraftKey?: (input: string, key: { return?: boolean; backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean }) => void
  draft?: string
  children?: ReactNode
}

export function App({
  model,
  committed,
  active,
  onToggleTool,
  onConfirm,
  onCancel,
  onDraftKey,
  draft,
  activity,
  activityText,
  iter,
  maxIter,
  tokens,
  cost,
  mcp,
  sandbox,
  sandboxDanger,
  warning,
  warningLevel,
  conditions,
  banner,
  running,
  children,
}: AppProps): ReactElement {
  const busy =
    running ??
    (active.streamingText !== '' ||
      active.confirm !== null ||
      activity === 'thinking' ||
      activity === 'tool' ||
      activity === 'retry')
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
        onDraftKey={onDraftKey}
        draft={draft}
        conditions={conditions}
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
              sandbox={sandbox}
              sandboxDanger={sandboxDanger}
            />
            <Text dimColor> · </Text>
            <ShortcutHint context={busy ? 'busy' : 'default'} />
          </Box>
          {warning !== undefined && (
            <Text color={warningLevel === 'error' ? theme.error : warningLevel === 'info' ? theme.info : theme.warn}>
              {warning}
            </Text>
          )}
        </Box>
      </Conversation>
    </Box>
  )
}
