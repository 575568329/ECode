import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { ToolLine, formatBytes } from './ToolLine.js'
import { mergeToolGroup, previewLine } from './toolview.js'
import { theme } from './theme.js'
import { symbols, toolIcon } from './symbols.js'
import { clipWidth, useViewport } from './viewport.js'
import { GAP, INDENT, WIDTH } from './layout.js'
import { stripUntrustedAnsi } from '../protocol/sanitize.js'
import { makeToolDigest } from '../protocol/toolDigest.js'
import type { ActiveTool } from './types.js'

/**
 * 工具合并块（G1 薄壳化，详设 §5.1）：Static 历史区的多工具组渲染——组头 + N×ToolLine。
 * 单工具组在 renderCommitted 侧直接走 ToolLine（省略组头，动静切换无跳变）。
 * 单工具行渲染已收口 ToolLine（mode=static：副作用 diff 全量 D15）；旧本地实现
 * （onToggle-proxy 判定/expandCap/折叠 preview）随活动流 B4/R2 退役。
 *
 * 2026-09-03 同名紧凑态（用户拍板「相同的工具能折叠也折叠——占位太大」）：全组同名且
 * 非 edit/write → 组头「name ×N」+ 单行/条（digest+状态+preview 同行）+ 还有 N 条。
 * 副作用组不进（D15 diff 全量）；异名组保持原「N 个工具」组头渲染。
 */
interface ToolGroupViewProps {
  tools: ActiveTool[]
  /** M14-V5 总守卫：可见工具数上限（缺省不设限=Static 固化语义） */
  maxTools?: number
}

/** run 折叠豁免集（与动态区 viewport.ts RUN_FOLD_EXEMPT 同口径：D15 diff 全量） */
const COMPACT_EXEMPT = new Set(['edit_file', 'write_file'])

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
  const sameName =
    tools.length >= 2 &&
    tools.every((t) => t.name === tools[0]!.name) &&
    !tools.some((t) => COMPACT_EXEMPT.has(t.name))
  if (sameName) return <CompactToolGroup tools={tools} maxTools={maxTools} columns={columns} />

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

/**
 * 同名紧凑组：每条一行（digest+状态+preview 同行）——N 条同名调用从 N×2 行收敛到
 * 组头 1 + 可见 N 行 + 溢出 1。digest/preview 六四分宽（命令是主要辨识信息），
 * 各自 clipWidth 截断（… 明示）。全文兜底恒在：Ctrl+T 全屏时间线。
 */
function CompactToolGroup({ tools, maxTools, columns }: { tools: ActiveTool[]; maxTools?: number; columns: number }): ReactElement {
  const capped = maxTools !== undefined && tools.length > maxTools
  const toolsShown = capped ? tools.slice(0, maxTools) : tools
  const hiddenTools = capped ? tools.length - toolsShown.length : 0
  const { visible, overflow } = mergeToolGroup(toolsShown)
  const name = tools[0]!.name
  const errors = tools.filter((t) => t.status === 'error').length
  // 单行宽度预算：toolOutput 口径（columns−10）内 digest 与 preview 六四开。
  // 分隔符实占 5 列（" ✓"2 + " ▸ "3——审阅修复：原按 4 计差 1 列击穿单行）；
  // truncated 尾巴/媒体标记在 preview 内预扣（见行内），不再追加在外
  const avail = WIDTH.toolOutput(columns)
  const digestW = Math.floor(avail * 0.55)
  const previewW = Math.max(6, avail - digestW - 5)

  return (
    <Box flexDirection="column" marginTop={GAP.block}>
      <Box>
        <Box minWidth={INDENT.icon}>
          <Text color={theme.tool}>{toolIcon(name)}</Text>
        </Box>
        <Text bold color={theme.tool}>
          {name}
        </Text>
        <Text dimColor>
          {' '}
          ×{tools.length}
          {errors > 0 ? ` · ${errors} 失败` : ''}
        </Text>
      </Box>
      {visible.map((t, i) => {
        const digest = clipWidth(
          t.digest ?? (t.use !== undefined ? makeToolDigest(t.name, t.use.input) : ''),
          digestW,
        )
        // 净化出口（审阅 S1 惯例）：工具输出=不可信面（OSC 52/OSC 8 注入主通道）
        const content = stripUntrustedAnsi(t.result?.content ?? '')
        // 审阅 P1（truncated 尾巴击穿单行）：preview 先粗算判 truncated，再扣除尾部标记
        // （⋯(NKB)）与媒体标记的实际宽度重算——digest 顶满 + truncated 时尾巴追加在
        // preview 之外会把行撑破成 2 行。媒体标记（[图片]/[PDF]）同扣（审阅 P2：多模态
        // 结果在紧凑行不再隐形）
        const mediaTag =
          (t.result?.blocks?.length ?? 0) > 0
            ? ` [${(t.result?.blocks ?? []).map((b) => (b.type === 'image' ? '图片' : 'PDF')).join(' ')}]`
            : ''
        const rough = previewLine(content, previewW)
        const bytesTag =
          content.length > rough.length ? ` ${symbols.trunc}(${formatBytes(Buffer.byteLength(t.result?.content ?? '', 'utf8'))})` : ''
        const reserve = stringWidth(`${bytesTag}${mediaTag}`)
        const preview = previewLine(content, Math.max(4, previewW - reserve))
        const truncated = content.length > preview.length
        const isError = t.status === 'error'
        return (
          <Box key={t.use?.id ?? `_${i}`}>
            <Box minWidth={INDENT.gutter}>
              <Text dimColor>{'  ⎿  '}</Text>
            </Box>
            <Text dimColor>
              {digest}
              <Text color={isError ? theme.error : theme.success}>
                {isError ? ` ${symbols.error}` : ` ${symbols.success}`}
              </Text>
              {content !== '' ? ` ${symbols.foldCollapsed} ${preview}` : ''}
              {mediaTag}
              {truncated ? bytesTag : ''}
            </Text>
          </Box>
        )
      })}
      {overflow > 0 && (
        <Box>
          <Box minWidth={INDENT.gutter}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          <Text dimColor>…还有 {overflow} 条（Ctrl+T 全程）</Text>
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
