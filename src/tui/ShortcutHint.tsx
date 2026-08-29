import type { ReactElement } from 'react'
import { Text } from 'ink'

/** 快捷键提示栏（TUI 规范 §7/§5.1）：最底，随上下文变。
 *  F-45（用户点名）：idle 态教学提示（⏎ 发送 // 命令/↑↓ 历史等）去除——渲染为空；
 *  busy 态保留 Ctrl+C 中断（运行中怎么打断是关键信息）。 */
const HINTS: Record<string, string> = {
  default: '',
  busy: 'Ctrl+C 中断 · Ctrl+T 输出',
}

interface ShortcutHintProps {
  context?: string
}

export function ShortcutHint({ context = 'default' }: ShortcutHintProps): ReactElement {
  const hint = HINTS[context] ?? HINTS.default
  return <Text dimColor>{hint}</Text>
}
