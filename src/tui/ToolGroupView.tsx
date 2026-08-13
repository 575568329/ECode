import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { mergeToolGroup, inputDigest } from './toolview.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import type { ActiveTool } from './types.js'

/**
 * 工具合并块（详设 §3 超额策略）。
 *
 * 折叠态恒 ≤4 行：表头 1 + visible 摘要（≤2）+ 溢出提示 1。
 * 不随工具数增长——visible 封顶 MAX_TOOL_VISIBLE，超出转溢出计数。
 * 展开态：全部工具摘要（临时增高，仅当前轮可展开）。
 *
 * 动态区（当前轮）：expanded 受控 + onToggle 可交互。
 * Static（历史 tool-group）：不传 expanded/onToggle，收起固化。
 */
interface ToolGroupViewProps {
  tools: ActiveTool[]
  /** 受控展开；默认 false（折叠） */
  expanded?: boolean
  onToggle?: () => void
}

export function ToolGroupView({ tools, expanded = false, onToggle }: ToolGroupViewProps): ReactElement {
  if (tools.length === 0) return <Box />
  const { count, visible, overflow } = mergeToolGroup(tools)
  const shown = expanded ? tools : visible
  const namesPreview = visible.map((t) => t.name).join(', ')
  const headerSuffix = overflow > 0 ? ` ${symbols.trunc} +${overflow} 个` : ''

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box minWidth={2}>
          <Text color={theme.tool}>{symbols.tool}</Text>
        </Box>
        <Text bold color={theme.tool}>
          {' '}
          {count} 个工具
        </Text>
        <Text dimColor>
          {' '}
          {namesPreview}
          {headerSuffix}
        </Text>
        {onToggle && (
          <Text dimColor> {expanded ? symbols.foldExpanded : symbols.foldCollapsed}</Text>
        )}
      </Box>
      {shown.map((t, i) => {
        const id = t.use?.id ?? `_${i}`
        const digest = t.use ? inputDigest(t.use.input) : ''
        const tail =
          t.status === 'error'
            ? { sym: symbols.error, color: theme.error }
            : t.status === 'done'
              ? { sym: symbols.success, color: theme.success }
              : null // running：无 tail（等 done 才 ✓/✗）
        return (
          <Box key={id} paddingLeft={3}>
            <Text dimColor>{t.name}</Text>
            {digest !== '' && <Text dimColor> {digest}</Text>}
            {tail && <Text color={tail.color}> {tail.sym}</Text>}
          </Box>
        )
      })}
      {!expanded && overflow > 0 && (
        <Box paddingLeft={3}>
          <Text dimColor>还有 {overflow} 个工具</Text>
        </Box>
      )}
    </Box>
  )
}
