import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ConfirmState } from './types.js'
import { theme } from './theme.js'

/**
 * 确认弹窗（详设 §7.3）：副作用工具执行前给用户决策。
 *
 * 交互：
 * - ← →：在「执行 / 取消」间切换（默认选中「执行」）
 * - 回车：确认当前选中（默认直接回车 = 执行）
 * - y/n：快捷键直接确认（兼容老习惯）
 * - Ctrl+C：取消该工具（P0#1：useInterrupt 守卫不抢）
 *
 * 展示：
 * - edit_file：unified diff（按行着色：- 红 / + 绿 / @@ 蓝 / --- +++ 加粗）
 * - write_file：content 片段（灰）
 * - bash：完整命令（灰）
 *
 * y/n/回车后组件由父卸载（active.confirm=null），不残留动态区。
 */

interface ConfirmPromptProps {
  state: ConfirmState
  /** 清 active.confirm（父卸载本组件） */
  onConfirm?: () => void
  onCancel?: () => void
}

/** diff 行着色：- 红 / + 绿 / @@ 蓝 / --- +++ 加粗 */
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
  // 默认选中「执行」（y）—— 直接回车就继续，符合「确认优先」直觉
  const [selected, setSelected] = useState<'y' | 'n'>('y')

  const decide = (ok: boolean) => {
    state.resolve(ok)
    if (ok) onConfirm?.()
    else onCancel?.()
  }

  useInput((inputChar, key) => {
    if (key.leftArrow || key.rightArrow) {
      // 两个选项，左右键 toggle
      setSelected((s) => (s === 'y' ? 'n' : 'y'))
    } else if (inputChar === 'y') {
      decide(true)
    } else if (inputChar === 'n') {
      decide(false)
    } else if (key.return) {
      decide(selected === 'y')
    } else if (key.ctrl && inputChar === 'c') {
      decide(false)
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
        <Text inverse={selected === 'y'} bold={selected === 'y'}>
          {' [y] 执行 '}
        </Text>
        <Text>   </Text>
        <Text inverse={selected === 'n'} bold={selected === 'n'}>
          {' [n] 取消 '}
        </Text>
        <Text dimColor>   ← →选择 · 回车确认 · Ctrl+C 取消</Text>
      </Box>
    </Box>
  )
}
