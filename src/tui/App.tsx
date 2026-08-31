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
  /** F-44：上下文占用/模型窗口（usage 帧透出）——StatusBar ctx 段 */
  ctxUsed?: number
  ctxWindow?: number
  /** F-48 批 1：alt-screen 全屏模式——chrome（StatusBar/提示/warning）不渲染（无状态损失） */
  altMode?: boolean
  /** F-48 批 1：alt 全屏内容（面板树）——Conversation 动态区整体替换，Static/InputStream 常驻 */
  altContent?: ReactNode
  cost?: string
  /** MCP 段（StatusBar 透传，M6） */
  mcp?: string
  /** M9-P4：沙箱模式段（StatusBar 透传；default 不显示） */
  sandbox?: string
  /** full-access 危险色 */
  sandboxDanger?: boolean
  /** T5（D-T3 增补）：daemon 运行段（附着态顶栏常驻） */
  daemon?: string
  daemonDanger?: boolean
  /** 运行时告警（重试/限流/压缩等）——底部独立第二行渲染并截断（防长消息挤碎状态行） */
  warning?: string
  /** 审阅 P1-1：条件段活跃态（TasksBar/SubagentBar——Conversation 总分配显式扣减）；
   *  审阅 P0-2：todoLines=常驻 todo 面板实占行数（同入扣减） */
  conditions?: { tasksBar?: boolean; subagentBar?: boolean; todoLines?: number }
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
  /** 批2b-fix：按键时刻直读主输入框权威值（透传 ConfirmPrompt） */
  readDraft?: () => string
  /** F-31：卡上 Ctrl+C=拒卡+中断整轮（透传 ConfirmPrompt） */
  onInterruptTurn?: () => void
  /** 插话排队留痕（2026-08-29 用户点名）：queue/snapshot 驱动，对话区动态渲染为排队用户行 */
  queuedInterjects?: string[]
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
  readDraft,
  onInterruptTurn,
  activity,
  activityText,
  iter,
  maxIter,
  tokens,
  ctxUsed,
  ctxWindow,
  altMode,
  altContent,
  cost,
  mcp,
  sandbox,
  sandboxDanger,
  daemon,
  daemonDanger,
  warning,
  warningLevel,
  conditions,
  banner,
  running,
  queuedInterjects,
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
      {/* 审阅 P0-1：banner/warning 均计入帧高——alt 全屏模式一并收口（面板独占帧账，
          否则 busy 中 Ctrl+T 时 warning/横幅把帧高顶过 rows 触发 win32 每帧全清） */}
      {!altMode && banner !== undefined && (
        <Box borderStyle="round" borderColor={theme.warn} paddingX={1}>
          <Text color={theme.warn}>⚠ {banner}</Text>
        </Box>
      )}
      <Conversation
        committed={committed}
        active={active}
        queuedInterjects={queuedInterjects}
        altContent={altContent}
        onToggleTool={onToggleTool}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onDraftKey={onDraftKey}
        draft={draft}
        readDraft={readDraft}
        onInterruptTurn={onInterruptTurn}
        conditions={conditions}
      >
        {!altMode && <ActivityBar state={activity} text={activityText} />}
        {children}
        <Box flexDirection="column">
          {!altMode && (
          <Box>
            <StatusBar
              model={model}
              iter={iter}
              maxIter={maxIter}
              tokens={tokens}
              ctxUsed={ctxUsed}
              ctxWindow={ctxWindow}
              cost={cost}
              mcp={mcp}
              sandbox={sandbox}
              sandboxDanger={sandboxDanger}
              daemon={daemon}
              daemonDanger={daemonDanger}
            />
            {/* F-45：idle 态快捷键教学提示去除（用户点名「⏎ 发送 / 命令 ↑↓ 历史这些都不用显示」）——
                busy 态保留 Ctrl+C 中断（运行中怎么打断是关键信息）；分隔符随 hint 存在性条件渲染 */}
            {busy && (
              <>
                <Text dimColor> · </Text>
                <ShortcutHint context="busy" />
              </>
            )}
          </Box>
          )}
          {!altMode && warning !== undefined && (
            <Text color={warningLevel === 'error' ? theme.error : warningLevel === 'info' ? theme.info : theme.warn}>
              {warning}
            </Text>
          )}
        </Box>
      </Conversation>
    </Box>
  )
}
