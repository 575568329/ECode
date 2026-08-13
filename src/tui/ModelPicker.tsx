import type { ReactElement } from 'react'
import { Text } from 'ink'
import { Select, type SelectItem } from './Select.js'

/**
 * /model 选择器：通用 Select 的 provider/model 适配壳（§8.2 / D5）。
 *
 * 交互（↑↓/回车/Esc/inverse）全在 Select，这里只负责把 ModelEntry
 * 转成 SelectItem（label + active 判定）。P1-3 抽 Select 后此文件即薄壳。
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
  const items: SelectItem<ModelEntry>[] = entries.map((e) => ({
    label: (
      <>
        {e.name} <Text dimColor>/</Text> {e.model}
      </>
    ),
    value: e,
    active: e.name === current.name && e.model === current.model,
  }))
  return <Select title="切换供应商/模型" items={items} onSelect={onPick} onCancel={onCancel} />
}
