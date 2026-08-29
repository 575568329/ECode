import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { theme } from './theme.js'

interface StatusBarProps {
  model: string
  iter?: number
  maxIter?: number
  tokens?: number
  /** F-44：上下文占用/模型窗口（usage 帧透出）——ctx 段显示占用与余量，≥90%（压缩阈值）warn 色 */
  ctxUsed?: number
  ctxWindow?: number
  cost?: string
  /** MCP 段（M6：'MCP 2/3' / 'MCP 连接中…'；undefined 不显示） */
  mcp?: string
  /** M9-P4：沙箱模式段（default 不显示；read-only/workspace-write 常驻；full-access 危险色常驻） */
  sandbox?: string
  /** full-access 危险色（M9-D12） */
  sandboxDanger?: boolean
}

/** token 数人类可读：< 1000 显示原值，否则 k */
function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`
  return `${(n / 1000).toFixed(1)}k tok`
}

/** C2 档位可视化（CC ⏵⏵ 式）：default 无标记、accept-edits ⏵⏵ edits、其余各档箭头数递进 */
export function sandboxArrows(mode: string): string {
  switch (mode) {
    case 'accept-edits':
      return '⏵⏵ edits'
    case 'workspace-write':
      return '⏵⏵ write'
    case 'full-access':
      return '⏵⏵⏵'
    case 'read-only':
      return '⛔ read-only'
    default:
      return ''
  }
}

/**
 * 顶栏：model / 轮数 / token / 成本（TUI 规范 §4.2/§7）。
 * warning 不在此渲染——运行时告警由 App 层渲染为底部独立第二行（长消息截断，
 * 防止 429 等含 JSON body 的错误把本行与快捷键提示挤碎）。
 */
export function StatusBar({ model, iter, maxIter, tokens, ctxUsed, ctxWindow, cost, mcp, sandbox, sandboxDanger }: StatusBarProps): ReactElement {
  const arrows = sandbox !== undefined ? sandboxArrows(sandbox) : ''
  // F-44：ctx 段（占用/窗口，如 45k/200k）——占用取 usage 帧 API 真值（input+cacheRead）；
  // ≥90% 窗口（压缩触发阈值 0.9，compaction/strategy.ts）转 warn 色：余量将尽、下轮即压
  const ctxRatio = ctxUsed !== undefined && ctxWindow !== undefined && ctxWindow > 0 ? ctxUsed / ctxWindow : null
  const ctxHot = ctxRatio !== null && ctxRatio >= 0.9
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
      {ctxUsed !== undefined && ctxWindow !== undefined && (
        <Text dimColor={!ctxHot} color={ctxHot ? theme.warn : undefined} bold={ctxHot}>
          {' · ctx '}{formatTokens(ctxUsed).replace(' tok', '')}/{formatTokens(ctxWindow).replace(' tok', '')}
        </Text>
      )}
      {mcp !== undefined && <Text dimColor> · {mcp}</Text>}
      {sandbox !== undefined && (
        sandboxDanger
          ? <Text color={theme.error} bold> · ⚠ {arrows !== '' ? `${arrows} ` : ''}{sandbox}</Text>
          : <Text dimColor> · {arrows !== '' ? `${arrows} · ` : ''}{sandbox}</Text>
      )}
      {cost !== undefined && <Text dimColor> · {cost}</Text>}
    </Box>
  )
}
