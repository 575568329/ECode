import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { summarize, type ToolCallEntry } from './toolview.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { GAP, INDENT } from './layout.js'

/**
 * 单个工具调用渲染（TUI 规范 §4.11 / M2 方案 B.3）：
 *   [●] [工具名 bold] [inputDigest] [✓/✗]
 *      ▸ 输出首行… (折叠, 1.2KB)
 *      ▾ 输出 (1.2KB)
 *        <完整内容>
 * 折叠/展开由父组件 expanded 受控（Ctrl+O 全展，放弃 Tab 焦点交互）。
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

interface ToolCallViewProps {
  entry: ToolCallEntry
  /** 受控展开（Ctrl+O 全展时传 true）；不传则按 summarize.collapsed 默认 */
  expanded?: boolean
}

export function ToolCallView({ entry, expanded }: ToolCallViewProps): ReactElement {
  const s = summarize(entry)
  const collapsed = expanded !== undefined ? !expanded : s.collapsed
  const content = entry.result?.content ?? ''
  const hasOutput = content.length > 0

  const markColor =
    s.status === 'running' ? theme.dim : s.status === 'error' ? theme.error : theme.tool
  const tail: { sym: string; color: string } | null =
    s.status === 'success'
      ? { sym: symbols.success, color: theme.success }
      : s.status === 'error'
        ? { sym: symbols.error, color: theme.error }
        : null

  return (
    <Box flexDirection="column" marginTop={GAP.block}>
      <Box>
        <Box minWidth={INDENT.icon}>
          <Text color={markColor}>{symbols.tool}</Text>
        </Box>
        <Text bold color={theme.tool}>
          {' '}
          {s.name}
        </Text>
        {s.inputDigest !== '' && <Text dimColor> {s.inputDigest}</Text>}
        {tail !== null && <Text color={tail.color}> {tail.sym}</Text>}
      </Box>
      {hasOutput && (
        <Box flexDirection="column" paddingLeft={INDENT.gutter}>
          <Box>
            <Text dimColor>{collapsed ? symbols.foldCollapsed : symbols.foldExpanded}</Text>
            {collapsed ? (
              <Text dimColor>
                {' '}
                {s.preview}
                {content.length > s.preview.length
                  ? ` ${symbols.trunc}(${formatBytes(s.bytes)})`
                  : ''}
              </Text>
            ) : (
              <Text dimColor> 输出 ({formatBytes(s.bytes)})</Text>
            )}
          </Box>
          {!collapsed && (
            <Text color={s.status === 'error' ? theme.error : undefined}>{content}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}
