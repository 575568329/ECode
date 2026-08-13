import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

/**
 * 模型选择器（/model 命令触发，方案 §8.2 / D5 自建 Select）。
 *
 * 列 config.providers 的笛卡尔积（provider × model），当前激活项标 `(当前)`。
 * 复用 SlashSuggest 上下选中 + ConfirmPrompt 全屏覆盖范式（border 框 + useInput 独占）。
 *
 * 交互：↑↓ 导航（环绕）· 回车确认 · Esc/Ctrl+C 取消。
 * 选中靠 inverse 反色高亮（不用箭头字符，规避 ambiguous 字符宽度问题）。
 */

/** 单个可选条目（provider × model 笛卡尔积的一项）。 */
export interface ModelEntry {
  name: string // provider 名（astron / deepseek）
  model: string // 模型名
}

interface ModelPickerProps {
  entries: ModelEntry[]
  /** 当前激活条目（标记 `(当前)` + 初始光标定位到此） */
  current: { name: string; model: string }
  onPick: (entry: ModelEntry) => void
  onCancel: () => void
}

export function ModelPicker({ entries, current, onPick, onCancel }: ModelPickerProps): ReactElement {
  // 初始光标 = 当前激活项；不在列表则回退第一项（findIndex 找不到返回 -1 → Math.max 兜底 0）
  const initialIdx = Math.max(
    0,
    entries.findIndex((e) => e.name === current.name && e.model === current.model),
  )
  const [idx, setIdx] = useState(initialIdx)

  useInput((input, key) => {
    if (key.upArrow) {
      setIdx((i) => (i <= 0 ? entries.length - 1 : i - 1))
    } else if (key.downArrow) {
      setIdx((i) => (i >= entries.length - 1 ? 0 : i + 1))
    } else if (key.return) {
      onPick(entries[idx])
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        切换供应商/模型
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.map((e, i) => {
          const selected = i === idx
          const active = e.name === current.name && e.model === current.model
          return (
            <Text key={`${e.name}/${e.model}`} inverse={selected} bold={selected}>
              {' '}
              {e.name} <Text dimColor={!selected}>/</Text> {e.model}
              {active ? '  (当前)' : ''}
            </Text>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓选择 · 回车确认 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
