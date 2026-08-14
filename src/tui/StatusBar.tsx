import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { theme } from './theme.js'

interface StatusBarProps {
  model: string
  iter?: number
  maxIter?: number
  tokens?: number
  cost?: string
  warning?: string
  /** MCP 段（M6：'MCP 2/3' / 'MCP 连接中…'；undefined 不显示） */
  mcp?: string
}

/** token 数人类可读：< 1000 显示原值，否则 k */
function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`
  return `${(n / 1000).toFixed(1)}k tok`
}

/** 顶栏：model / 轮数 / token / 成本 / 警告（TUI 规范 §4.2/§7） */
export function StatusBar({ model, iter, maxIter, tokens, cost, warning, mcp }: StatusBarProps): ReactElement {
  return (
    <Box>
      <Text color={theme.status}>ECode · </Text>
      <Text bold>{model}</Text>
      {iter !== undefined && (
        <Text dimColor>
          {' · 轮 '}
          {iter}
          {maxIter !== undefined ? `/${maxIter}` : ''}
        </Text>
      )}
      {tokens !== undefined && <Text dimColor> · {formatTokens(tokens)}</Text>}
      {mcp !== undefined && <Text dimColor> · {mcp}</Text>}
      {cost !== undefined && <Text dimColor> · {cost}</Text>}
      {warning !== undefined && <Text color={theme.warn}> · {warning}</Text>}
    </Box>
  )
}
