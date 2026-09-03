/**
 * 面板壳（M6 T1/S-P6）：标题/副标题/窗口化滚动/键位提示行/分组导航/即时搜索。
 *
 * 新建组件（不从 Select 改造——Select 无窗口滚动/搜索/分组行/键位提示行），
 * 复用其交互语义（↑↓ 环绕/Enter/Esc/inverse 高亮）与 theme。
 * 键位（T4）：↑↓ 环绕 / Enter 确认 / Esc 先清搜索词再退出 / PageUp·PageDown 翻页 /
 * 任意可打印字符进入即时搜索（因此 j/k 与数字直选不进 MVP——与搜索互斥）。
 * 挂载复用 overlay 机制（面板独占输入，主输入框 inactive）。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'
import { sectionBudget, useViewport } from './viewport.js'

/** 窗口化滚动高度上限（T1：超 12 行滚动 + 边缘提示）。 */
const MAX_VISIBLE = 12
/** 高度感知预留（M14-V2；相对 budget=rows−2）：面板骨架（marginTop1+边框2+标题1+副标题1+
 * 提示行1+搜索行1）+ 底部三行 + 余量——24 行兜底终端下仍得 12（现测试行为不变） */
const VISIBLE_RESERVE = 10
/** 极矮终端保命线 */
const MIN_VISIBLE = 3

export type PanelRow<T> = { type: 'header'; label: string } | { type: 'item'; value: T; label: ReactNode; disabled?: boolean }

export interface PanelShellProps<T> {
  title: string
  subtitle?: string
  rows: PanelRow<T>[]
  /** 选中条目（Enter） */
  onPick: (value: T) => void
  /** 退出（Esc 清词后 / Ctrl+C） */
  onCancel: () => void
  /** 底部键位提示行（默认 ↑↓ 选择 · 回车 确认 · 输入即搜索 · Esc 返回） */
  keyHints?: string
  /** 搜索过滤（null 关闭搜索；默认按 label 文本） */
  filter?: (value: T, query: string) => boolean
  /** 空态提示 */
  emptyHint?: string
  /** 光标移动回调（MCP 面板：failed 行随光标展开错误用） */
  onCursor?: (value: T | undefined) => void
  /** 页签（M7 P7 扩展）：提供时 ←→ 切换（搜索态左右仍留给后续编辑，不抢占） */
  tabs?: string[]
  activeTabIndex?: number
  onTabChange?: (index: number) => void
  /** 数字直达（2026-09-03 Ctrl+T 根菜单拍板）：未搜索时 1-9 直接选中第 N 个可见条目。
   *  仅菜单类面板开——其他面板数字首字符是合法搜索词（如任务 id），开了会截走 */
  numericPick?: boolean
}

/** 从 rows 提取 label 的纯文本（默认搜索匹配用；ReactNode 取字符串叶子）。 */
export function rowText(label: ReactNode): string {
  if (typeof label === 'string') return label
  if (typeof label === 'number') return String(label)
  if (Array.isArray(label)) return label.map(rowText).join(' ')
  if (label !== null && typeof label === 'object' && 'props' in (label as object)) {
    return rowText((label as { props: { children?: ReactNode } }).props?.children)
  }
  return ''
}

/** F-48b：SGR 鼠标事件全形态识别（滚轮 64/65、按键 0-2、motion 32+；M 按下/m 释放）——
 *  鼠标跟踪开启期间这些序列经 Ink 透传为 useInput 的 input 字符串，若不识别会被
 *  搜索 catch-all 当可打印字符吃掉（真机实证：滚轮→搜索框出现 '[<65;21;8M]'）。
 *  审阅 T1：正则曾被写成 /^[<d+;d+;d+[Mm]$/（丢 \[\d 转义，实为单字符类）——左键/motion
 *  全部漏过滤进搜索词。导出共享，OutputViewer 搜索分支同源消费。 */
export function isMouseInput(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input)
}

export function PanelShell<T>({
  title,
  subtitle,
  rows,
  onPick,
  onCancel,
  keyHints,
  filter,
  emptyHint,
  onCursor,
  tabs,
  activeTabIndex,
  onTabChange,
  numericPick,
}: PanelShellProps<T>): ReactElement {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  // M14-V2 rows 感知：窗口高度 = min(12, budget−10)——矮终端面板不再撑爆动态区；
  // 24 行兜底终端下仍为 12（VISIBLE_RESERVE 换算保持现行为）
  const { budget } = useViewport()
  const maxVisible = Math.max(MIN_VISIBLE, sectionBudget(budget, VISIBLE_RESERVE, MAX_VISIBLE))
  // 光标项回调在下方 items/cursor 计算后经 useEffect 触发（见 items 定义处）

  // 过滤：只对 item 行；空组（过滤后无条目）的 header 丢弃
  const visible = useMemo(() => {
    if (query === '') return rows
    const q = query.toLowerCase()
    const out: PanelRow<T>[] = []
    let lastHeader: PanelRow<T> | null = null
    let headerEmitted = false
    for (const r of rows) {
      if (r.type === 'header') {
        lastHeader = r
        headerEmitted = false
      } else {
        const hit = filter !== undefined ? filter(r.value, query) : rowText(r.label).toLowerCase().includes(q)
        if (hit) {
          if (lastHeader !== null && !headerEmitted) {
            out.push(lastHeader)
            headerEmitted = true
          }
          out.push(r)
        }
      }
    }
    return out
  }, [rows, query, filter])

  const items = visible.filter((r): r is Extract<PanelRow<T>, { type: 'item' }> => r.type === 'item')
  const clamp = (i: number): number => (items.length === 0 ? 0 : Math.max(0, Math.min(items.length - 1, i)))
  // idx 指向 items 数组的第几个（header 不占光标）
  const cursor = clamp(idx)
  const currentItem = items[cursor]

  // 光标项回调（依赖收敛到当前值：items 是每次 render 的 filter 新引用，进依赖会让
  // 每次渲染都触发——幂等回调时恰好收敛，非幂等（如 setBusy(对象)）立即死循环，审阅 P2）
  const currentVal = currentItem?.value
  useEffect(() => {
    onCursor?.(currentVal)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 值相等即语义相等
  }, [currentVal])

  // 窗口化滚动：光标为中心（对齐调研实现），窗口 [start, start+MAX_VISIBLE)
  const windowStart = items.length <= maxVisible ? 0 : Math.max(0, Math.min(items.length - maxVisible, cursor - Math.floor(maxVisible / 2)))
  // visible 行序 → 窗口内渲染（header 只要出现在窗口区间就保留）
  let itemPos = -1
  const rendered: ReactElement[] = []
  for (let vi = 0; vi < visible.length; vi++) {
    const r = visible[vi]
    if (r.type === 'header') {
      const nextItem = visible.findIndex((x, j) => j > vi && x.type === 'item')
      const inWindow = items.length <= maxVisible || itemPos + 1 < windowStart + maxVisible
      if (inWindow && (nextItem === -1 || visiblePosToItemPos(nextItem) >= windowStart)) {
        rendered.push(
          <Text key={`h${vi}`} bold color={theme.info}>
            {' '}
            {r.label}
          </Text>,
        )
      }
    } else {
      itemPos++
      if (itemPos < windowStart || itemPos >= windowStart + maxVisible) continue
      const selected = itemPos === cursor
      rendered.push(
        <Text key={`i${vi}`} inverse={selected} bold={selected} color={r.disabled ? theme.border : undefined}>
          {' '}
          {r.label}
        </Text>,
      )
    }
  }

  useInput((input, key) => {
    // 页签切换（M7 P7）：优先于一切分支——空页签（如未安装任何插件的「已安装」页）
    // 也要能切走，否则用户被困在空页（真机复现：空列表守卫吞掉左右键）。
    // 搜索态同样切换并清词（搜索无光标编辑，左右无第二用途；残留搜索词到新页签会错乱过滤）。
    if (tabs !== undefined && onTabChange !== undefined && (key.leftArrow || key.rightArrow)) {
      const delta = key.rightArrow ? 1 : -1
      if (query !== '') setQuery('')
      onTabChange((activeTabIndex === undefined ? 0 : activeTabIndex + delta + tabs.length) % tabs.length)
      return
    }
    // 空列表也要能退出/清词（搜索无匹配时 backspace 必须可用，否则锁死在无匹配态）
    if (items.length === 0) {
      if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1))
      else if (key.escape) {
        if (query !== '') setQuery('')
        else onCancel()
      } else if (key.ctrl && input === 'c') onCancel()
      return
    }
    // F-48：SGR 鼠标滚轮（Ink 透传形态 '[<64;y;xC' 上滚 / '[<65;y;xC' 下滚）→ 列表滚动。
    // alt buffer 无原生滚轮，鼠标跟踪上报的序列若不接住会被尾部搜索 catch-all 当可打印
    // 字符吃进搜索词（真机实证：滚一下搜索框出现 '[<65;21;8M'）
    const wheel = /^\[<(\d+);\d+;\d+M$/.exec(input ?? '')
    if (wheel !== null && (Number(wheel[1]) === 64 || Number(wheel[1]) === 65)) {
      const up = Number(wheel[1]) === 64
      if (up) setIdx(cursor <= 0 ? items.length - 1 : cursor - 1)
      else setIdx(cursor >= items.length - 1 ? 0 : cursor + 1)
    } else if (key.upArrow) {
      setIdx(cursor <= 0 ? items.length - 1 : cursor - 1)
    } else if (key.downArrow) {
      setIdx(cursor >= items.length - 1 ? 0 : cursor + 1)
    } else if (key.pageUp) {
      setIdx(clamp(cursor - maxVisible))
    } else if (key.pageDown) {
      setIdx(clamp(cursor + maxVisible))
    } else if (key.return) {
      const item = items[cursor]
      if (item !== undefined && !item.disabled) onPick(item.value)
    } else if (key.escape) {
      if (query !== '') setQuery('') // Esc 逐级：先清搜索词
      else onCancel()
    } else if (key.ctrl && input === 'c') {
      onCancel() // T4：面板期间 Ctrl+C = 退出面板（不中断 loop）
    } else if (input === 'q' && query === '') {
      // 审阅 T2：列表页宣称「q 退出」（pager 惯例）但无分支——q 落进 catch-all 进搜索词。
      // 仅未在搜索态时生效（搜索中 q 是普通字符）
      onCancel()
    } else if (numericPick === true && query === '' && /^[1-9]$/.test(input ?? '')) {
      // 数字直达：未搜索时 1-9 选中第 N 个可见条目（搜索态数字继续进词——纯数字搜索
      // 如任务 id 只在已输入其他字符后出现，首字符数字被直达消费的损失可接受）
      const target = items[Number(input) - 1]
      if (target !== undefined && !target.disabled) onPick(target.value)
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
    } else if (input !== '' && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !isMouseInput(input)) {
      setQuery((q) => q + input) // 即时搜索（可打印字符；F-48 排除全部鼠标形态）
    }
  })

  const hiddenAbove = windowStart > 0 ? windowStart : 0
  const hiddenBelow = Math.max(0, items.length - (windowStart + maxVisible))
  const empty = items.length === 0

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {' '}
        {title}
        {subtitle !== undefined ? <Text dimColor>  {subtitle}</Text> : null}
      </Text>
      {tabs !== undefined && tabs.length > 0 && (
        <Box>
          {tabs.map((t, i) => (
            <Text key={`tab${i}`} inverse={i === (activeTabIndex ?? 0)} bold={i === (activeTabIndex ?? 0)} color={i === (activeTabIndex ?? 0) ? undefined : theme.border}>
              {i === 0 ? ' ' : '  '}
              {t}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {query !== '' && (
          <Text dimColor>
            {' '}
            搜索：{query}▏
          </Text>
        )}
        {empty ? (
          <Text dimColor> {query !== '' ? `无匹配（${query}）` : (emptyHint ?? '（空）')}</Text>
        ) : (
          <>
            {hiddenAbove > 0 && (
              <Text dimColor>
                {' '}
                ↑ 还有 {hiddenAbove} 项
              </Text>
            )}
            {rendered}
            {hiddenBelow > 0 && (
              <Text dimColor>
                {' '}
                ↓ 还有 {hiddenBelow} 项
              </Text>
            )}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor> {keyHints ?? '↑↓ 选择 · 回车 确认 · 输入即搜索 · Esc 返回'}</Text>
      </Box>
    </Box>
  )

  /** visible 下标 → item 序号（header 跳过）。 */
  function visiblePosToItemPos(visIdx: number): number {
    let n = -1
    for (let j = 0; j <= visIdx && j < visible.length; j++) {
      if (visible[j].type === 'item') n++
    }
    return n
  }
}
