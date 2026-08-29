import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { useClock } from './clock.js'
import { theme } from './theme.js'
import { GAP } from './layout.js'
import type { ActivityState } from '../core/loop.js'

// braille 乒乓帧（设计理念 §7.6：正向 + 反向来回弹，比单向更柔和）
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function spinnerChar(frame: number): string {
  const n = SPINNER_FRAMES.length
  const cycle = frame % (n * 2)
  return SPINNER_FRAMES[cycle < n ? cycle : n * 2 - 1 - cycle]
}

interface ActivityBarProps {
  state: ActivityState
  /** 工具名（tool 态）/ 上下文文案 */
  text?: string
}

/**
 * ActivityBar：常驻输入框上方，当前动作指示（TUI 规范 §4.10）。
 *
 * - idle：占位空行（布局稳定、不抢眼，不订阅 clock）
 * - thinking / tool / retry：spinner + 上下文文案（订阅共享 useClock）
 * - aborted：⚠ 已中断，内容已保留
 *
 * spinner 共享 useClock 单时钟（设计理念 §7.4：N 个动画一个 setInterval，帧同步）。
 * 把 useClock 下沉到 ActiveSpinner 子组件，idle/aborted 时不订阅（不空转）。
 */
export function ActivityBar({ state, text }: ActivityBarProps): ReactElement {
  // F-36：marginTop 级联补位（ToolGroupView 已去 marginBottom，此处自带与消息块间的 1 空行）
  if (state === 'idle') {
    return (
      <Box marginTop={GAP.block}>
        <Text>{' '}</Text>
      </Box>
    )
  }
  if (state === 'aborted') {
    return (
      <Box marginTop={GAP.block}>
        <Text color={theme.warn}>⚠ 已中断，内容已保留</Text>
      </Box>
    )
  }
  return (
    <Box marginTop={GAP.block}>
      <ActiveSpinner state={state} text={text} />
    </Box>
  )
}

function ActiveSpinner({ state, text }: { state: ActivityState; text?: string }): ReactElement {
  const frame = useClock()
  const spinner = spinnerChar(frame)
  const label =
    state === 'thinking'
      ? '思考中'
      : state === 'retry'
        ? '重试中'
        : text ?? '执行中'
  const color = state === 'retry' ? theme.warn : theme.activity
  return (
    <Box>
      <Text color={color}>{spinner}</Text>
      <Text> {label}</Text>
    </Box>
  )
}
