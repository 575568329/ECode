import type { ReactElement } from 'react'
import { Text } from 'ink'
import { Select, type SelectItem } from './Select.js'
import type { SessionMeta } from '../services/history.js'

/**
 * /history 选择器：通用 Select 的会话恢复适配壳（§9.1）。
 *
 * 列 history.loadAll()（按 createdAt 倒序，最新在最上），每项
 * `firstUser · 时间 · model`。无「当前」概念（不像 ModelPicker）——初始光标在第一项（最新）。
 * 交互全在 Select，这里只负责 label 组装。
 */

interface HistoryPickerProps {
  metas: SessionMeta[]
  onSelect: (sessionId: string) => void
  onCancel: () => void
}

/** ISO → 'YYYY-MM-DD HH:mm'（列表紧凑显示，秒级精度无意义） */
function formatTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

export function HistoryPicker({ metas, onSelect, onCancel }: HistoryPickerProps): ReactElement {
  const items: SelectItem<string>[] = metas.map((m) => ({
    label: (
      <>
        {m.firstUser} <Text dimColor>
          · {formatTime(m.createdAt)} · {m.model}
        </Text>
      </>
    ),
    value: m.sessionId,
  }))
  return (
    <Select title="恢复历史会话" items={items} onSelect={onSelect} onCancel={onCancel} emptyHint="无历史会话" />
  )
}
