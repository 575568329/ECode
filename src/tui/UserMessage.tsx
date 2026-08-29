import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { symbols } from './symbols.js'
import { theme } from './theme.js'
import { GAP } from './layout.js'

/** 用户消息：背景块 + ❯ 蓝前缀 + 文字不灰（调研 Claude Code UserPromptMessage：靠背景区分，文字保持亮色） */
export function UserMessage({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={GAP.block} backgroundColor={theme.userBg} paddingLeft={1} paddingRight={1}>
      <Text color={theme.info} bold>{symbols.prompt}</Text>
      <Text color={theme.user}> {text}</Text>
    </Box>
  )
}
