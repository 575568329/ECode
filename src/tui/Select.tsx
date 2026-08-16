import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

/**
 * 通用列表选择器（D5 自建，P1-3 从 ModelPicker 提炼）。
 *
 * 只管交互（↑↓ 环绕导航 / 回车确认 / Esc·Ctrl+C 取消 / inverse 高亮），
 * 不懂任何业务——调用方传 `{label, value, active}` items。
 *
 * 复用范式：ModelPicker（provider×model）/ HistoryPicker（会话）/ 未来 skill·mcp 选择。
 * 选中靠 inverse 反色（不用箭头字符，规避 ambiguous 字符宽度问题）。
 * 空列表：显示 emptyHint + 仅响应 Esc（不崩，通用空态）。
 *
 * 窗口化（对齐 PanelShell）：列表超 MAX_VISIBLE 项只渲染光标居中的可见窗口——
 * 动态区 outputHeight ≥ 视口行数会触发 Ink fullscreen（视角顶到顶部、scrollback
 * 被清），/history 会话多的场景全量渲染必炸屏；窗口外以上/下溢出计数提示。
 */

/** 可见窗口行数（与 PanelShell MAX_VISIBLE 同值） */
const MAX_VISIBLE = 12

export interface SelectItem<T> {
  /** 渲染文本（调用方组装，如 'glm-5.2 / astron' 或 '首条消息 · 时间'） */
  label: ReactNode
  /** 选中后回传的值 */
  value: T
  /** 当前激活（标记 `(当前)` + 初始光标定位到此） */
  active?: boolean
}

interface SelectProps<T> {
  title?: string
  items: SelectItem<T>[]
  onSelect: (value: T) => void
  onCancel: () => void
  /** 空列表提示文案（默认「（空）」） */
  emptyHint?: string
}

export function Select<T>({ title, items, onSelect, onCancel, emptyHint }: SelectProps<T>): ReactElement {
  // 初始光标定位到 active 项；无 active 回退第一项（findIndex 找不到返回 -1 → Math.max 兜底 0）
  const initialIdx = Math.max(0, items.findIndex((it) => it.active))
  const [idx, setIdx] = useState(initialIdx)

  useInput((input, key) => {
    if (items.length === 0) {
      // 空列表：只响应取消，不导航/确认
      if (key.escape || (key.ctrl && input === 'c')) onCancel()
      return
    }
    if (key.upArrow) {
      setIdx((i) => (i <= 0 ? items.length - 1 : i - 1))
    } else if (key.downArrow) {
      setIdx((i) => (i >= items.length - 1 ? 0 : i + 1))
    } else if (key.return) {
      const item = items[idx]
      if (item) onSelect(item.value) // P2-5：guard 越界（items 变化时 idx 可能超出长度）
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
    }
  })

  const empty = items.length === 0
  // 窗口化滚动：光标为中心，窗口 [start, start+MAX_VISIBLE)——渲染行数封顶，防动态区超视口
  const windowStart =
    items.length <= MAX_VISIBLE ? 0 : Math.max(0, Math.min(items.length - MAX_VISIBLE, idx - Math.floor(MAX_VISIBLE / 2)))
  const hiddenAbove = windowStart
  const hiddenBelow = Math.max(0, items.length - (windowStart + MAX_VISIBLE))
  const shown = items.slice(windowStart, windowStart + MAX_VISIBLE)
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      {title !== undefined && (
        <Text color={theme.info} bold>
          {title}
        </Text>
      )}
      {empty ? (
        <Box marginTop={1}>
          <Text dimColor>{emptyHint ?? '（空）'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {hiddenAbove > 0 && (
            <Text dimColor>
              {' '}↑ 还有 {hiddenAbove} 项
            </Text>
          )}
          {shown.map((it, i) => {
            const pos = windowStart + i
            const selected = pos === idx
            return (
              <Text key={pos} inverse={selected} bold={selected}>
                {' '}
                {it.label}
                {it.active ? '  (当前)' : ''}
              </Text>
            )
          })}
          {hiddenBelow > 0 && (
            <Text dimColor>
              {' '}↓ 还有 {hiddenBelow} 项
            </Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{empty ? 'Esc 返回' : '↑↓选择 · 回车确认 · Esc 取消'}</Text>
      </Box>
    </Box>
  )
}
