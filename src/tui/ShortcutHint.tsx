import type { ReactElement } from 'react'
import { Text } from 'ink'

/** busy 态提示（2026-09-02 精简批：^C/^T 记法 + Ctrl+T 语义是「展开」查看器非「输出」——用户纠正）。
 *  导出常量：App 层用其宽度参与 StatusBar 守卫扣减（同行防 wrap），单源防漂移。 */
export const BUSY_HINT = '^C中断 ^T展开'

/** 快捷键提示栏（TUI 规范 §7/§5.1）：最底，随上下文变。
 *  F-45（用户点名）：idle 态教学提示（⏎ 发送 // 命令/↑↓ 历史等）去除——渲染为空；
 *  busy 态保留 Ctrl+C 中断（运行中怎么打断是关键信息）。 */
const HINTS: Record<string, string> = {
  default: '',
  busy: BUSY_HINT,
}

interface ShortcutHintProps {
  context?: string
}

export function ShortcutHint({ context = 'default' }: ShortcutHintProps): ReactElement {
  const hint = HINTS[context] ?? HINTS.default
  return <Text dimColor>{hint}</Text>
}
