/**
 * 视口预算与物理行折叠基础层（M14 §3.1/§3.2，V1）。
 *
 * 超屏防护根因（M14 §0.2）：动态区帧高 ≥ 终端行数时 Ink 走全屏兜底
 * （ESC[2J+3J+H 清 scrollback，视角跳顶滚不动）。全 TUI 的视口感知统一
 * 从本模块取，预算公式收敛一处——此前 Select/ConfirmPrompt 各写一份 rows−N。
 *
 * - budget = rows − SAFETY_MARGIN：Windows conhost 帧高恰好等于 rows 也触发
 *   全清（ink #969），必须留余量，动态区目标帧高恒 ≤ budget；
 * - 折叠是数据级（先按显示宽度 wrap 成物理行再切窗），不做渲染后测量——
 *   measureElement 需渲染后回读再重渲，形成闪跳反馈环（M14-D2）。
 */
import { useEffect, useState } from 'react'
import { useStdout } from 'ink'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'

/** 帧高必须留出的余量（Windows 恰满屏也触发全清，ink #969） */
export const SAFETY_MARGIN = 2
/** 极矮终端预算下限（低于此值由各段保命线与 V5 退化保护兜底） */
export const MIN_BUDGET = 8
/** 非 TTY / rows 未知时的兜底视口行数（与 ink getWindowSize 80×24 默认一致） */
export const ROWS_FALLBACK = 24
export const COLUMNS_FALLBACK = 80

export interface Viewport {
  rows: number
  columns: number
  /** 动态区帧高预算：目标 ≤ budget（= rows − 2） */
  budget: number
}

/** 纯函数：终端行数 → 帧高预算 */
export function computeBudget(rows: number): number {
  return Math.max(MIN_BUDGET, rows - SAFETY_MARGIN)
}

/**
 * 视口 hook（M14 §3.1）：resize 触发重渲，非 TTY 兜底 24 行。
 *
 * F-40：共享单监听——ink 原生 useWindowSize 是「每组件实例各挂一个 stdout.on('resize')」，
 * Static 历史区每个 ToolGroupView 都调用且长期挂载，恢复长会话累积 N 个监听
 * （MaxListenersExceededWarning: 11 resize listeners added to [WriteStream]，dogfood
 * 2026-08-29 实证）。本模块改为模块级共享 1 个 resize 监听 + 订阅者集合，
 * N 个组件恒 1 个底层监听；组件卸载只退订集合（底层监听常驻，进程级单份）。
 */
const resizeListeners = new Set<() => void>()
let sharedAttached = false

function ensureSharedResize(stdout: NodeJS.WriteStream): void {
  if (sharedAttached) return
  sharedAttached = true
  stdout.on('resize', () => {
    for (const l of resizeListeners) l()
  })
}

function readSize(stdout: NodeJS.WriteStream | undefined): { rows: number; columns: number } {
  const rows = typeof stdout?.rows === 'number' && stdout.rows > 0 ? stdout.rows : ROWS_FALLBACK
  const columns = typeof stdout?.columns === 'number' && stdout.columns > 0 ? stdout.columns : COLUMNS_FALLBACK
  return { rows, columns }
}

export function useViewport(): Viewport {
  const { stdout } = useStdout()
  const [size, setSize] = useState(() => readSize(stdout))
  useEffect(() => {
    if (stdout === undefined) return
    ensureSharedResize(stdout)
    const onResize = (): void => setSize(readSize(stdout))
    resizeListeners.add(onResize)
    return () => {
      resizeListeners.delete(onResize)
    }
  }, [stdout])
  return { rows: size.rows, columns: size.columns, budget: computeBudget(size.rows) }
}

/**
 * 各段预算分配的单一公式（M14 §3.1）：某段可用行数 = budget − 其余段预留。
 * 下限 1（保命），上限 cap（如列表窗口 12）。组件自己的极矮保命线
 * （Select MIN_VISIBLE=3、ConfirmPrompt PREVIEW_MIN_LINES=5）在调用侧
 * Math.max——floor 是组件策略不是公式策略。
 */
export function sectionBudget(budget: number, reserve: number, cap = Number.POSITIVE_INFINITY): number {
  return Math.max(1, Math.min(cap, budget - reserve))
}

/** M14-V5（§3.4）总守卫：动态区顶层一次分配 */
export interface DynamicAllocation {
  /** 退化保护：终端过小（budget < 12）——markdown/stream/工具区不渲染（宁可不显示也不触发 3J） */
  degraded: boolean
  /** 流式灰字/轮末残留 markdown 行上限（拿大头——§3.4 公式） */
  streamMaxLines: number
  /** 工具组可见数上限（每组收起恒 ≤4 行；超出折叠为「…还有 N 组」提示） */
  toolGroupCap: number
}

/**
 * 动态区总预算分配（M14-V5 §3.4）：各段独立截断不保证**总和** < rows（病态组合
 * 8 组工具×4 行+灰字+输入仍超 24 行终端），Conversation 顶层算一次下发各段。
 * 预留 = 输入区 3（粘贴折叠钳制后）+ ActivityBar 1 + StatusBar 1 + 子代理/任务条 ~5
 * （App 骨架实际占用对齐）；confirm/overlay 打开时 ConfirmPrompt 自管公式（不变）。
 */
export function allocateDynamic(
  budget: number,
  conditions: { tasksBar?: boolean; subagentBar?: boolean; todoLines?: number } = {},
): DynamicAllocation {
  // 审阅 P1-1/P1-2：输入区折叠态实占最多 7-8 行（INPUT_FOLD_MAX_LINES=5+上下折叠指示+caret 行），
  // 原 3 行预算低估；条件段（TasksBar/SubagentBar 各 ≤3 行）活跃时显式扣减——原"挤占余量"
  // 只有注释无机制，24 行终端最坏叠加 32 行 >> budget。
  // 四角色审阅 P0-2：todo 常驻面板（≤12 项+表头+溢出提示 ≤14 行）同入条件段扣减——
  // 此前完全未入账，用过 todo 的会话在小终端常态超预算触发 3J。
  // TuiApp 以同一纯函数自算 degraded 驱动 TodoPanel maxVisible（0=隐藏），两处口径同源。
  const todoLines = Math.max(0, Math.min(Math.floor(conditions.todoLines ?? 0), 14))
  const USER_INPUT_LINES = 8
  const CHROME_RESERVE =
    5 + (conditions.tasksBar === true ? 3 : 0) + (conditions.subagentBar === true ? 3 : 0) + todoLines
  const STREAM_MIN = 4 // 流式区保底（tail 折叠天然弹性，是余量的缓冲垫）
  const condLines =
    (conditions.tasksBar === true ? 3 : 0) + (conditions.subagentBar === true ? 3 : 0) + todoLines
  // 退化线：保住最小可用内容（1 组 4 行 + stream 4 行）= CHROME 5 + 输入 8 + 8
  if (budget < 21 + condLines) return { degraded: true, streamMaxLines: 0, toolGroupCap: 0 }
  const content = Math.max(4, budget - CHROME_RESERVE - USER_INPUT_LINES)
  const toolGroupCap = Math.max(1, Math.min(6, Math.floor((content - STREAM_MIN) / 4)))
  const streamMaxLines = Math.max(STREAM_MIN, content - toolGroupCap * 4)
  return { degraded: false, streamMaxLines, toolGroupCap }
}

/** 折叠模式：tail=只留尾部（流式灰字/输入粘贴）；head-tail=头尾都留（diff/长输出） */
export type FoldMode = 'tail' | 'head-tail'

export interface FoldResult {
  /** 可见物理行（head-tail 模式 = 头段+尾段按序拼接） */
  visible: string[]
  /** 折叠提示行插在 visible 的哪个下标之前（tail 模式恒 0） */
  markerAt: number
  /** 被折叠掉的物理行数 */
  foldedCount: number
  /** 总物理行数（wrap 后） */
  totalPhysical: number
}

/**
 * 物理行折叠（M14 §3.2）：先按显示宽度 wrap（治超长单行——minified JSON /
 * 长 URL 逻辑一行可爆几十物理行），再切窗。宽度用 wrap-ansi（hard 硬断长
 * token；CJK/emoji 宽度经 string-width——ambiguous 默认窄，与 Ink 自身
 * 布局口径一致，测试已钉行为）。
 *
 * @param keep.head head-tail 模式保留的头部行数（默认 3——diff 文件名/hunk 定位）
 */
export function foldLines(
  text: string,
  maxLines: number,
  width: number,
  mode: FoldMode = 'tail',
  keep: { head?: number } = {},
): FoldResult {
  const wrapWidth = Number.isFinite(width) && width >= 1 ? Math.floor(width) : null
  const physical =
    wrapWidth === null
      ? text.split('\n')
      : text
          .split('\n')
          .flatMap((line) => (line === '' ? [''] : wrapAnsi(line, wrapWidth, { hard: true, trim: false }).split('\n')))
  const total = physical.length
  const windowMax = Math.max(1, Math.floor(maxLines))
  if (total <= windowMax) {
    return { visible: physical, markerAt: 0, foldedCount: 0, totalPhysical: total }
  }
  if (mode === 'head-tail' && windowMax >= 2) {
    const headKeep = Math.max(1, Math.min(keep.head ?? 3, windowMax - 1))
    const tailKeep = windowMax - headKeep
    return {
      visible: [...physical.slice(0, headKeep), ...physical.slice(total - tailKeep)],
      markerAt: headKeep,
      foldedCount: total - windowMax,
      totalPhysical: total,
    }
  }
  return {
    visible: physical.slice(total - windowMax),
    markerAt: 0,
    foldedCount: total - windowMax,
    totalPhysical: total,
  }
}

/** 审阅 P1-7：按显示宽度截断列表/状态行（string-width 感知 CJK；超宽 wrap 会使
 *  PanelShell/TasksBar 的"每 item 1 行"窗口化预算翻倍失效——OutputViewer/TasksBar 共用） */
export function clipWidth(text: string, max: number, ellipsis = '…'): string {
  if (stringWidth(text) <= max) return text
  let out = ''
  for (const ch of text) {
    if (stringWidth(out + ch) > max - stringWidth(ellipsis)) break
    out += ch
  }
  return out + ellipsis
}
