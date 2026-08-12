import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import type { AppError } from '../core/types.js'

/** fatal 错误统一展示（TUI 规范 §7 ErrorBanner） */
export function ErrorBanner({ error }: { error: AppError }): ReactElement {
  return (
    <Box>
      <Text color={theme.error}>{symbols.error}</Text>
      <Text color={theme.error}> {error.message}</Text>
      <Text dimColor> ({error.code})</Text>
    </Box>
  )
}
