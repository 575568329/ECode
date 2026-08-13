import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ConfirmState } from './types.js'
import { theme } from './theme.js'

/**
 * 确认弹窗（详设 §7.3）：副作用工具执行前给用户 y/n 决策。
 *
 * - edit_file：unified diff（按行着色：- 红 / + 绿 / @@ 蓝）
 * - write_file：content 片段（灰）
 * - bash：完整命令字符串（灰）
 *
 * useInput 抓 y/n/Ctrl+C → resolve + 清 confirm（P0#1：useInterrupt 守卫不抢 Ctrl+C）。
 * y/n 后组件由父卸载（active.confirm=null），不残留动态区。
 */

interface ConfirmPromptProps {
  state: ConfirmState
  /** 清 active.confirm（父卸载本组件） */
  onConfirm?: () => void
  onCancel?: () => void
}

/** diff 行着色：- 红 / + 绿 / @@ 蓝 / --- +++ 标题加粗 */
function DiffLine({ line }: { line: string }): ReactElement {
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

export function ConfirmPrompt({ state, onConfirm, onCancel }: ConfirmPromptProps): ReactElement {
  const input = state.use.input as Record<string, unknown>
  const target = String(input.path ?? input.command ?? '')
  const isDiff = state.use.name === 'edit_file'

  useInput((inputChar, key) => {
    if (inputChar === 'y') {
      state.resolve(true)
      onConfirm?.()
    } else if (inputChar === 'n' || (key.ctrl && inputChar === 'c')) {
      state.resolve(false)
      onCancel?.()
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Box>
        <Text color={theme.warn} bold>
          ⚠ 执行 {state.use.name}?
        </Text>
        {target !== '' && <Text> {target}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {isDiff
          ? state.preview.split('\n').map((line, i) => (
              <Box key={i}>
                <DiffLine line={line} />
              </Box>
            ))
          : <Text dimColor>{state.preview}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text bold>[y]</Text>
        <Text dimColor> 执行   </Text>
        <Text bold>[n]</Text>
        <Text dimColor> 取消   </Text>
        <Text dimColor>(Ctrl+C 取消该工具)</Text>
      </Box>
    </Box>
  )
}
