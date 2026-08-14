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

/** 窗口化滚动高度（T1：超 12 行滚动 + 边缘提示）。 */
const MAX_VISIBLE = 12

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
}: PanelShellProps<T>): ReactElement {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
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

  // 光标项回调（导航/过滤变化时通知；MCP 面板 failed 行随光标展开错误用）
  useEffect(() => {
    onCursor?.(currentItem?.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 光标/列表变化时通知
  }, [cursor, items])

  // 窗口化滚动：光标为中心（对齐调研实现），窗口 [start, start+MAX_VISIBLE)
  const windowStart = items.length <= MAX_VISIBLE ? 0 : Math.max(0, Math.min(items.length - MAX_VISIBLE, cursor - Math.floor(MAX_VISIBLE / 2)))
  // visible 行序 → 窗口内渲染（header 只要出现在窗口区间就保留）
  let itemPos = -1
  const rendered: ReactElement[] = []
  for (let vi = 0; vi < visible.length; vi++) {
    const r = visible[vi]
    if (r.type === 'header') {
      const nextItem = visible.findIndex((x, j) => j > vi && x.type === 'item')
      const inWindow = items.length <= MAX_VISIBLE || itemPos + 1 < windowStart + MAX_VISIBLE
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
      if (itemPos < windowStart || itemPos >= windowStart + MAX_VISIBLE) continue
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
    // 空列表也要能退出/清词（搜索无匹配时 backspace 必须可用，否则锁死在无匹配态）
    if (items.length === 0) {
      if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1))
      else if (key.escape) {
        if (query !== '') setQuery('')
        else onCancel()
      } else if (key.ctrl && input === 'c') onCancel()
      return
    }
    if (key.upArrow) {
      setIdx(cursor <= 0 ? items.length - 1 : cursor - 1)
    } else if (key.downArrow) {
      setIdx(cursor >= items.length - 1 ? 0 : cursor + 1)
    } else if (key.pageUp) {
      setIdx(clamp(cursor - MAX_VISIBLE))
    } else if (key.pageDown) {
      setIdx(clamp(cursor + MAX_VISIBLE))
    } else if (key.return) {
      const item = items[cursor]
      if (item !== undefined && !item.disabled) onPick(item.value)
    } else if (key.escape) {
      if (query !== '') setQuery('') // Esc 逐级：先清搜索词
      else onCancel()
    } else if (key.ctrl && input === 'c') {
      onCancel() // T4：面板期间 Ctrl+C = 退出面板（不中断 loop）
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
    } else if (input !== '' && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab) {
      setQuery((q) => q + input) // 即时搜索（可打印字符）
    }
  })

  const hiddenAbove = windowStart > 0 ? windowStart : 0
  const hiddenBelow = Math.max(0, items.length - (windowStart + MAX_VISIBLE))
  const empty = items.length === 0

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {' '}
        {title}
        {subtitle !== undefined ? <Text dimColor>  {subtitle}</Text> : null}
      </Text>
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
