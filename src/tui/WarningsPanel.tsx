/**
 * /warnings 告警中心面板（M8 补充交付②）：三级分组浏览 + 清空。
 * Esc 退出不清空（历史保留，回车「清空全部」才清——用户决策）。
 */

import type { ReactElement } from 'react'
import { Text } from 'ink'
import { PanelShell, type PanelRow } from './PanelShell.js'
import { theme } from './theme.js'
import { groupNotices, type NoticeItem, type NoticeLevel } from './notices.js'

const LEVEL_LABEL: Record<NoticeLevel, { title: string; color: string; icon: string }> = {
  error: { title: '严重', color: theme.error, icon: '✖' },
  warn: { title: '警告', color: theme.warn, icon: '⚠' },
  info: { title: '提示', color: theme.info, icon: 'ℹ' },
}

interface WarningsPanelProps {
  notices: NoticeItem[]
  onClear: () => void
  onCancel: () => void
}

export function WarningsPanel({ notices, onClear, onCancel }: WarningsPanelProps): ReactElement {
  const rows: PanelRow<NoticeItem | '__clear__'>[] = []
  for (const g of groupNotices(notices)) {
    const meta = LEVEL_LABEL[g.level]
    rows.push({ type: 'header', label: `${meta.icon} ${meta.title}（${g.items.length}）` })
    for (const n of g.items) {
      rows.push({
        type: 'item',
        value: n,
        disabled: true, // 只读浏览（选中不触发动作）
        label: (
          <Text color={meta.color}>
            {' '}
            {meta.icon} {n.text.slice(0, 100)}
          </Text>
        ),
      })
    }
  }
  if (notices.length === 0) {
    return (
      <PanelShell
        title="告警中心"
        subtitle="无告警"
        rows={[{ type: 'item', value: '__clear__', label: ' （空——没有未读告警）', disabled: true }]}
        onPick={() => {}}
        onCancel={onCancel}
        emptyHint="（空）"
      />
    )
  }
  return (
    <PanelShell
      title="告警中心"
      subtitle={`共 ${notices.length} 条`}
      rows={[...rows, { type: 'item', value: '__clear__' as const, label: ' 清空全部告警' }]}
      onPick={(v) => {
        if (v === '__clear__') onClear()
      }}
      onCancel={onCancel}
      emptyHint="（空）"
      keyHints="↑↓ 浏览 · 回车 清空（仅「清空全部」项）· Esc 返回"
    />
  )
}
