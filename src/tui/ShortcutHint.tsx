import type { ReactElement } from 'react'
import { Text } from 'ink'

/** 快捷键提示栏（TUI 规范 §7/§5.1）：最底，随上下文变 */
const HINTS: Record<string, string> = {
  default: '⏎ 发送 · Ctrl+J 换行 · / 命令 · ↑↓ 历史 · Ctrl+C 退出',
  busy: 'Ctrl+C 中断',
}

interface ShortcutHintProps {
  context?: string
}

export function ShortcutHint({ context = 'default' }: ShortcutHintProps): ReactElement {
  const hint = HINTS[context] ?? HINTS.default
  return <Text dimColor>{hint}</Text>
}
