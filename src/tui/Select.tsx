import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'
import { sectionBudget, useViewport } from './viewport.js'

/**
 * 通用列表选择器（D5 自建，P1-3 从 ModelPicker 提炼）。
 *
 * 只管交互（↑↓ 环绕导航 / PageUp·PageDown 翻页 / 回车确认 / Esc·Ctrl+C 取消 / inverse 高亮），
 * 不懂任何业务——调用方传 `{label, value, active}` items。
 *
 * 复用范式：ModelPicker（provider×model）/ HistoryPicker（会话）/ 未来 skill·mcp 选择。
 * 选中靠 inverse 反色（不用箭头字符，规避 ambiguous 字符宽度问题）。
 * 空列表：显示 emptyHint + 仅响应 Esc（不崩，通用空态）。
 *
 * 窗口化（对齐 PanelShell）+ 高度感知（M9 审阅 P1-2 → M14-V1 收敛 viewport 公式）：
 * 可见行数 = min(12, budget−12)（budget = 视口−2）——Ink 是 >= 判定（恰好占满即
 * 触发 fullscreen 清 scrollback），中段双指示态 Select 总高 ≈ 窗口+11
 * （骨架 9 + ActivityBar/状态/输入 3 中取保守和），80×24 最小终端下窗口 10 才留得出余量。
 */

/** 可见窗口行数上限（与 PanelShell MAX_VISIBLE 同值；实际取 min(此值, 视口感知)） */
const MAX_VISIBLE = 12
/** 高度感知预留（相对 budget=rows−2；原 rows−14 换算）：中段态骨架（marginTop1+边框2+
 * title1+列表margin1+双指示2+底提示2+margin1）+ 底部三行 + 余量 */
const VISIBLE_RESERVE = 12
/** 极矮终端保命线 */
const MIN_VISIBLE = 3

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
  const { budget } = useViewport()
  const maxVisible = Math.max(MIN_VISIBLE, sectionBudget(budget, VISIBLE_RESERVE, MAX_VISIBLE))
  const clamp = (v: number): number => Math.max(0, Math.min(items.length - 1, v))

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
    } else if (key.pageUp) {
      setIdx((i) => clamp(i - maxVisible))
    } else if (key.pageDown) {
      setIdx((i) => clamp(i + maxVisible))
    } else if (key.return) {
      const item = items[idx]
      if (item !== undefined) onSelect(item.value) // P2-5：guard 越界（items 变化时 idx 可能超出长度）
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
    }
  })

  const empty = items.length === 0
  // 窗口化滚动：光标为中心，窗口 [start, start+maxVisible)——渲染行数封顶，防动态区超视口
  const windowStart =
    items.length <= maxVisible ? 0 : Math.max(0, Math.min(items.length - maxVisible, idx - Math.floor(maxVisible / 2)))
  const hiddenAbove = windowStart
  const hiddenBelow = Math.max(0, items.length - (windowStart + maxVisible))
  const shown = items.slice(windowStart, windowStart + maxVisible)
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
