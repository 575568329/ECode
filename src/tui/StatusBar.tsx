import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { theme } from './theme.js'

interface StatusBarProps {
  model: string
  iter?: number
  maxIter?: number
  tokens?: number
  cost?: string
  /** MCP 段（M6：'MCP 2/3' / 'MCP 连接中…'；undefined 不显示） */
  mcp?: string
}

/** token 数人类可读：< 1000 显示原值，否则 k */
function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`
  return `${(n / 1000).toFixed(1)}k tok`
}

/**
 * 顶栏：model / 轮数 / token / 成本（TUI 规范 §4.2/§7）。
 * warning 不在此渲染——运行时告警由 App 层渲染为底部独立第二行（长消息截断，
 * 防止 429 等含 JSON body 的错误把本行与快捷键提示挤碎）。
 */
export function StatusBar({ model, iter, maxIter, tokens, cost, mcp }: StatusBarProps): ReactElement {
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
    </Box>
  )
}
