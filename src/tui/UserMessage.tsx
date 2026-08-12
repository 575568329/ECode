import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { symbols } from './symbols.js'
import { theme } from './theme.js'

/** 用户消息：灰 ❯ + 文本（TUI 规范 §4.2） */
export function UserMessage({ text }: { text: string }): ReactElement {
  return (
    <Box>
      <Text color={theme.user}>{symbols.prompt}</Text>
      <Text color={theme.user}> {text}</Text>
    </Box>
  )
}
