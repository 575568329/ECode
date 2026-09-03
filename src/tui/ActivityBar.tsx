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
  /** 持续过程阶段（2026-09-03 拍板：持续性执行的内容不弹 5s 提示，放进 loading 行让用户
   *  知道 ecode 在工作）——busy 态替换主文案（压缩/重连期间 thinking tail 停滞，显示阶段
   *  名更准确）；idle 态把空行升级为 spinner+文案+计时（原 compactingSince 的泛化）。 */
  phase?: { text: string; since: number }
}

/**
 * ActivityBar：常驻输入框上方，当前动作指示（TUI 规范 §4.10；活动流 B4 动态化——
 * §4.10 本就要求「说明文字带具体动作（工具名+入参摘要），不是干转圈」，本批补齐兑现）。
 *
 * 整行恒单物理行（渲染审阅 P1-1）：spinner+label+detail+计时整体 clipWidth 到终端宽——
 * chrome 预算按 1 行记账，40 个 CJK 字 tail 在 80 列必折 2 行直通 3J。
 * 净化（管线审阅 P0-3）：detail 渲染口过无状态 strip（thinking 尾部/命令摘要均不可信面）。
 */
export function ActivityBar({ state, text, detail, turnStartedAt, phase }: ActivityBarProps): ReactElement {
  // F-38：marginTop 级联补位；aborted 提示收敛到底部告警行（TuiApp activity case），此处空行占位
  if (state === 'idle' || state === 'aborted') {
    // 持续过程 loading：空闲无轮但阶段进行中——空行升级为 spinner+文案+计时（黑箱修复）
    if (phase !== undefined) {
      return (
        <Box marginTop={GAP.block}>
          <ActiveSpinner state="compacting" text={phase.text} turnStartedAt={phase.since} />
        </Box>
      )
    }
    return (
      <Box marginTop={GAP.block}>
        <Text>{' '}</Text>
      </Box>
    )
  }
  return (
    <Box marginTop={GAP.block}>
      {/* 计时锚随文案走（审阅 P1）：phase 接管主文案时计时同步切到 phase.since——否则轮中自动
          压缩显示「正在压缩对话 · 12m30s」（轮总耗时冒充压缩耗时，违背「压缩消耗多少时间」
          点名诉求）；phase 清除后计时跳回轮起点（压缩几十秒内短暂跳变，可接受） */}
      <ActiveSpinner state={state} text={text} detail={detail} turnStartedAt={phase?.since ?? turnStartedAt} phaseText={phase?.text} />
    </Box>
  )
}

/** 尾部滚动（用户拍板 2026-09-02）：超宽取**最后** maxColumns 列——右边永远是最新的
 *  内容（无换行的持续输出=tail -f 滚动感，「程序还在走」的直接证据）；不超宽原样。 */
function tailLine(text: string, maxColumns: number): string {
  const width = stringWidth(text)
  if (width <= maxColumns) return text
  let out = ''
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (stringWidth(ch) + stringWidth(out) > maxColumns - 1) break
    out = ch + out
  }
  return `…${out}`
}

/** 显示态：core ActivityState + TUI 本地压缩态（不进 core 枚举——压缩是旁路操作非轮活动）。 */
type SpinnerState = ActivityState | 'compacting'

function ActiveSpinner({ state, text, detail, turnStartedAt, phaseText }: { state: SpinnerState; text?: string; detail?: string; turnStartedAt?: number; phaseText?: string }): ReactElement {
  const frame = useClock()
  const spinner = spinnerChar(frame)
  // phaseText（持续过程——压缩/重连/起草等）优先于状态文案：busy 态显示阶段名比冻结的
  //「思考中」准确；compacting 态 text 即阶段文案（缺省回退压缩）
  const base =
    phaseText ??
    (state === 'compacting'
      ? text ?? '正在压缩对话...'
      : state === 'thinking'
        ? '思考中'
        : state === 'retry'
          ? '重试中'
          : text ?? '执行中')
  const color = state === 'retry' ? theme.warn : theme.activity
  // 轮内耗时（每秒 +1——长工具期间 digest 不变但计时在走，用户知道程序还在走）；
  // compacting 同款计时（压缩消耗多少时间是用户点名要看的信息）
  const elapsed =
    turnStartedAt !== undefined && (state === 'thinking' || state === 'tool' || state === 'retry' || state === 'compacting')
      ? ` · ${formatElapsed(Date.now() - turnStartedAt)}`
      : ''
  // 用户拍板（2026-09-02 真机）：摘要放行末且灰色——主文案+计时完整优先，剩余宽度给摘要
  //（超宽裁摘要，主行永不折）；整行恒单物理行（spinner 1+空格 1+主行+摘要 ≤ columns）。
  // 滚动语义（同日拍板）：换行是「新行从头显示」的分段依据——取最后一个换行后的当前行，
  // 行内空白压平；当前行超宽时尾部滚动（右边一直显示最新内容），不超宽原样新内容从左填入
  const columns = typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 80
  const mainLine = `${base}${elapsed}`
  const cleanedDetail = detail !== undefined && detail !== '' ? stripUntrustedAnsi(detail).replace(/[^\S\n]+/g, ' ') : ''
  const currentLine = cleanedDetail.slice(cleanedDetail.lastIndexOf('\n') + 1).trim()
  const detailRoom = columns - 3 - stringWidth(mainLine)
  const detailLine = currentLine !== '' && detailRoom > 4 ? ` ${tailLine(currentLine, detailRoom - 1)}` : ''
  return (
    <Box>
      <Text color={color}>{spinner}</Text>
      <Text> {mainLine}</Text>
      {detailLine !== '' && <Text dimColor>{detailLine}</Text>}
    </Box>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m${s % 60}s`
}
