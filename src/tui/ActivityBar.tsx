import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import stringWidth from 'string-width'
import { useClock } from './clock.js'
import { theme } from './theme.js'
import { GAP } from './layout.js'
import { stripUntrustedAnsi } from '../protocol/sanitize.js'
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
  /** 活动流 B4（用户点名「loading 处看到在想什么/在跑什么」）：动态摘要——
   *  thinking 态=最新 live thinking 尾部（滚动感=「程序还在走」的直接证据，D10 tail）；
   *  tool 态=最新 item/executing digest（「正在执行 <命令>」，D9）。调用方从 timeline 派生。 */
  detail?: string
  /** 轮开始时间戳（轮内耗时递增显示——ZCode「工作中 2 分 31 秒」同款强动态信号，审阅产品 P2-1） */
  turnStartedAt?: number
}

/**
 * ActivityBar：常驻输入框上方，当前动作指示（TUI 规范 §4.10；活动流 B4 动态化——
 * §4.10 本就要求「说明文字带具体动作（工具名+入参摘要），不是干转圈」，本批补齐兑现）。
 *
 * 整行恒单物理行（渲染审阅 P1-1）：spinner+label+detail+计时整体 clipWidth 到终端宽——
 * chrome 预算按 1 行记账，40 个 CJK 字 tail 在 80 列必折 2 行直通 3J。
 * 净化（管线审阅 P0-3）：detail 渲染口过无状态 strip（thinking 尾部/命令摘要均不可信面）。
 */
export function ActivityBar({ state, text, detail, turnStartedAt }: ActivityBarProps): ReactElement {
  // F-38：marginTop 级联补位；aborted 提示收敛到底部告警行（TuiApp activity case），此处空行占位
  if (state === 'idle' || state === 'aborted') {
    return (
      <Box marginTop={GAP.block}>
        <Text>{' '}</Text>
      </Box>
    )
  }
  return (
    <Box marginTop={GAP.block}>
      <ActiveSpinner state={state} text={text} detail={detail} turnStartedAt={turnStartedAt} />
    </Box>
  )
}

function clipLine(text: string, maxColumns: number): string {
  const width = stringWidth(text)
  if (width <= maxColumns) return text
  let out = ''
  for (const ch of text) {
    if (stringWidth(out + ch) > maxColumns - 1) break
    out += ch
  }
  return `${out}…`
}

function ActiveSpinner({ state, text, detail, turnStartedAt }: { state: ActivityState; text?: string; detail?: string; turnStartedAt?: number }): ReactElement {
  const frame = useClock()
  const spinner = spinnerChar(frame)
  const base =
    state === 'thinking'
      ? '思考中'
      : state === 'retry'
        ? '重试中'
        : text ?? '执行中'
  const color = state === 'retry' ? theme.warn : theme.activity
  // 轮内耗时（每秒 +1——长工具期间 digest 不变但计时在走，用户知道程序还在走）
  const elapsed =
    turnStartedAt !== undefined && (state === 'thinking' || state === 'tool' || state === 'retry')
      ? ` · ${formatElapsed(Date.now() - turnStartedAt)}`
      : ''
  const detailText = detail !== undefined && detail !== '' ? ` ${stripUntrustedAnsi(detail)}` : ''
  // 整行单物理行：spinner 1 + 空格 1 + base + detail + elapsed，clip 到终端宽
  const columns = typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 80
  const line = clipLine(`${base}${detailText}${elapsed}`, columns - 3)
  return (
    <Box>
      <Text color={color}>{spinner}</Text>
      <Text> {line}</Text>
    </Box>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m${s % 60}s`
}
