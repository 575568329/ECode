import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { ToolLine } from './ToolLine.js'
import { mergeToolGroup } from './toolview.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { clipWidth, useViewport } from './viewport.js'
import { GAP, INDENT, WIDTH } from './layout.js'
import type { ActiveTool } from './types.js'

/**
 * 工具合并块（G1 薄壳化，详设 §5.1）：Static 历史区的多工具组渲染——组头 + N×ToolLine。
 * 单工具组在 renderCommitted 侧直接走 ToolLine（省略组头，动静切换无跳变）。
 * 单工具行渲染已收口 ToolLine（mode=static：副作用 diff 全量 D15）；旧本地实现
 * （onToggle-proxy 判定/expandCap/折叠 preview）随活动流 B4/R2 退役。
 */
interface ToolGroupViewProps {
  tools: ActiveTool[]
  /** M14-V5 总守卫：可见工具数上限（缺省不设限=Static 固化语义） */
  maxTools?: number
}

export function ToolGroupView({ tools, maxTools }: ToolGroupViewProps): ReactElement {
  const { columns } = useViewport()
  if (tools.length === 0) return <Box />
  // 审阅 P2：maxTools=0 渲单行折叠提示即返回（不渲「0 个工具」空组头）
  if (maxTools === 0) {
    return (
      <Box flexDirection="column" marginTop={GAP.block}>
        <Box>
          <Box minWidth={INDENT.icon}>
            <Text dimColor>{symbols.tool}</Text>
          </Box>
          <Text dimColor>{tools.length} 个工具已折叠（终端过小——Ctrl+T 查看全程）</Text>
        </Box>
      </Box>
    )
  }
  const capped = maxTools !== undefined && tools.length > maxTools
  const toolsShown = capped ? tools.slice(0, maxTools) : tools
  const hiddenTools = capped ? tools.length - maxTools : 0
  const { count, visible, overflow } = mergeToolGroup(toolsShown)
  // F-09：表头名字串压右边界截断收口（… 明示，末字符永不静默丢字）
  const namesPreview = clipWidth(visible.map((t) => t.name).join(', '), WIDTH.toolNames(columns))
  const headerSuffix = overflow > 0 ? ` ${symbols.trunc} +${overflow} 个` : ''

  return (
    <Box flexDirection="column" marginTop={GAP.block}>
      <Box>
        <Box minWidth={INDENT.icon}>
          <Text color={theme.tool}>{symbols.tool}</Text>
        </Box>
        <Text bold color={theme.tool}>
          {count} 个工具
        </Text>
        <Text dimColor>
          {' '}
          {namesPreview}
          {headerSuffix}
        </Text>
      </Box>
      {visible.map((t, i) => (
        <ToolLine key={t.use?.id ?? `_${i}`} tool={t} mode="static" />
      ))}
      {overflow > 0 && (
        <Box>
          <Box minWidth={INDENT.gutter}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          <Text dimColor>还有 {overflow} 个工具</Text>
        </Box>
      )}
      {capped && (
        <Box>
          <Box minWidth={INDENT.gutter}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          <Text dimColor>…还有 {hiddenTools} 个工具因终端预算折叠（Ctrl+T 查看全文）</Text>
        </Box>
      )}
    </Box>
  )
}
