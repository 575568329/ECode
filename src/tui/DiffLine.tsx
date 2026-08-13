import type { ReactElement } from 'react'
import { Text } from 'ink'
import { theme } from './theme.js'

/**
 * diff 行着色（共用：ConfirmPrompt + ToolGroupView）。
 * - `---` / `+++`：加粗（文件头）
 * - `@@`：蓝（hunk header）
 * - `-`：红（删除行）
 * - `+`：绿（新增行）
 * - 其他：默认（context 行 / 摘要）
 */
export function DiffLine({ line }: { line: string }): ReactElement {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return <Text bold>{line}</Text>
  }
  if (line.startsWith('@@')) {
    return <Text color={theme.info}>{line}</Text>
  }
  if (line.startsWith('-')) {
    return <Text color={theme.error}>{line}</Text>
  }
  if (line.startsWith('+')) {
    return <Text color={theme.success}>{line}</Text>
  }
  return <Text>{line}</Text>
}
