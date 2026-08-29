import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { mergeToolGroup, inputDigest, previewLine } from './toolview.js'
import { DiffLine } from './DiffLine.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { clipWidth, foldLines, useViewport } from './viewport.js'
import { GAP, INDENT, WIDTH } from './layout.js'
import type { ActiveTool } from './types.js'

/** gutter 列（排版批②：对齐 CC MessageResponse 模式——dim ⎿ + 右侧内容列，
 *  子内容 wrap 宽度被约束在内容列内，续行自动对齐 ⎿ 下方 = 悬挂缩进） */
function Gutter(): ReactElement {
  return (
    <Box minWidth={INDENT.gutter}>
      <Text dimColor>{'  ⎿  '}</Text>
    </Box>
  )
}

/** 字节数格式化（B/KB/MB）。与 ToolCallView 一致，复用同一展示约定。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 展开输出行数上限（M14-V2 §3.2：Ctrl+O 展开的工具输出 head-tail 上限——
 *  min(12, budget/2)；V3 OutputViewer 落地后此为"就地瞥"，全文回看走 /output） */
const EXPAND_CAP = 12

/**
 * 工具合并块（详设 §3 超额策略）。
 *
 * 折叠态恒 ≤4 行：表头 1 + visible 摘要（≤2）+ 溢出提示 1。
 * 不随工具数增长——visible 封顶 MAX_TOOL_VISIBLE，超出转溢出计数。
 * 展开态：全部工具摘要 + **输出全文**（临时增高，仅当前轮可展开）。
 *
 * 每工具含输出区（与旧 ToolCallView 一致）：
 *   折叠：▸ preview 首行（截断 + …NB）
 *   展开：▾ 输出 (NB) + 完整 content
 *
 * 动态区（当前轮）：expanded 受控 + onToggle 可交互。
 * Static（历史 tool-group）：不传 expanded/onToggle，收起固化（含 ▸ preview）。
 */
interface ToolGroupViewProps {
  tools: ActiveTool[]
  /** 受控展开（Ctrl+O 全展）；默认 false（折叠） */
  expanded?: boolean
  /** 界面批 B1：单工具级展开 id 集（Ctrl+E 循环）——命中的工具独立展开看全文，不整组展开 */
  expandedIds?: Set<string>
  /** 本轮是否结束（runLoop 完成）。副作用工具仅在本轮结束时展开 diff，进行中折叠省空间（本轮可能多 edit） */
  done?: boolean
  onToggle?: () => void
  /** M14-V5 总守卫：可见工具数上限（每组收起恒 ≤4 行不随数增长，但组内工具并行 8 个仍 32 行——
   *  超出截断为提示行；缺省不设限=Static 收起固化语义不变） */
  maxTools?: number
}

export function ToolGroupView({ tools, expanded = false, expandedIds, done, onToggle, maxTools }: ToolGroupViewProps): ReactElement {
  const { budget, columns } = useViewport()
  // M14-V2：展开输出 head-tail 上限（预算一半封顶、绝对上限 12；宽度扣 paddingLeft3+缩进2）
  const expandCap = Math.min(EXPAND_CAP, Math.max(3, Math.floor(budget / 2)))
  const expandWidth = WIDTH.toolOutput(columns)
  if (tools.length === 0) return <Box />
  // M14-V5：可见上限截断（expanded 态同截——展开大输出本就有 expandCap，工具数也须收口）
  const capped = maxTools !== undefined && tools.length > maxTools
  const toolsShown = capped ? tools.slice(0, maxTools) : tools
  const hiddenTools = capped ? tools.length - maxTools : 0
  const { count, visible, overflow } = mergeToolGroup(toolsShown)
  const shown = expanded ? toolsShown : visible
  // F-09：表头名字串压终端右边界时末字符被裁（"bash"→"bas"，ambiguous 宽度/边界取整误差）——
  // clipWidth 提前收口：超宽以 … 明示截断，末名永不静默丢字（CC 工具行同思路：摘要列固定收口）
  const namesPreview = clipWidth(visible.map((t) => t.name).join(', '), WIDTH.toolNames(columns))
  const headerSuffix = overflow > 0 ? ` ${symbols.trunc} +${overflow} 个` : ''

  return (
    <Box flexDirection="column" marginTop={GAP.block} marginBottom={GAP.block}>
      <Box>
        <Box minWidth={INDENT.icon}>
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
        const content = t.result?.content ?? ''
        const mediaBlocks = t.result?.blocks ?? []
        const hasOutput = content.length > 0 || mediaBlocks.length > 0
        const bytes = Buffer.byteLength(content, 'utf8')
        // 副作用工具（edit_file/write_file）默认展开输出（直接显示 diff/content），
        // 只读工具默认折叠（▸ preview）；Ctrl+O 全展开覆盖
        const isSideEffect = t.name === 'edit_file' || t.name === 'write_file'
        // 副作用工具（edit_file/write_file）仅动态区轮末（done=true）展开 diff（看刚改了什么）；
        // 进行中（done=false）与 Static 固化（done=undefined）都收起——历史默认全收起（用户拍板）。
        // 界面批 B1：expandedIds 命中的工具单选展开（Ctrl+E 循环，独立于组级 expanded）
        const showFull = expanded || (isSideEffect && done === true) || (expandedIds !== undefined && t.use !== undefined && expandedIds.has(t.use.id))
        const preview = previewLine(content)
        // M11-P6 todo 特化：digest 显示完成度，展开态逐项 ASCII 状态符（[x]/[->]/[ ]——ambiguous 宽度教训只用 ASCII）
        const isTodo = t.name === 'todo'
        const todoItems =
          isTodo && t.use
            ? ((t.use.input as { todos?: Array<{ content: string; status: string }> }).todos ?? [])
            : []
        const todoDone = todoItems.filter((x) => x.status === 'completed').length
        return (
          <Box key={id} flexDirection="column">
            <Box>
              {/* 排版批补：组内工具行行首图标列（用户对照 CC 指出「图标都在最前面」——
                  组头聚合不能代替每行的图标锚点；名称起于第 2 列=⎿ 悬挂列，视觉对齐 CC） */}
              <Box minWidth={INDENT.icon}>
                <Text dimColor>{symbols.tool}</Text>
              </Box>
              <Text bold>{t.name}</Text>
              {isTodo ? (
                <Text dimColor> {todoDone}/{todoItems.length} 完成</Text>
              ) : (
                digest !== '' && <Text dimColor> {digest}</Text>
              )}
              {tail && <Text color={tail.color}> {tail.sym}</Text>}
            </Box>
            {isTodo && showFull && todoItems.length > 0 && (
              <Box flexDirection="column">
                {todoItems.map((x, i) => (
                  <Box key={i}>
                    <Gutter />
                    <Text
                      color={x.status === 'in_progress' ? theme.info : undefined}
                      bold={x.status === 'in_progress'}
                    >
                      {x.status === 'completed' ? '[x] ' : x.status === 'in_progress' ? '[->] ' : '[ ] '}
                      {x.content}
                    </Text>
                  </Box>
                ))}
              </Box>
            )}
            {hasOutput && (
              <Box flexDirection="column">
                {showFull ? (
                  <>
                    <Box>
                      <Gutter />
                      <Text dimColor>
                        {symbols.foldExpanded} 输出 ({formatBytes(bytes)})
                        {t.at !== undefined ? ` · ${new Date(t.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}` : ''}
                      </Text>
                    </Box>
                    {(() => {
                      // M14-V2：展开全文不再无界——物理行 head-tail（头 3 定位 + 尾最新），中段折叠提示
                      const fold = foldLines(content, expandCap, expandWidth, 'head-tail')
                      const head = fold.visible.slice(0, fold.markerAt)
                      const tail = fold.visible.slice(fold.markerAt)
                      const marker =
                        fold.foldedCount > 0 ? (
                          <Box>
                            <Gutter />
                            <Text dimColor>
                              {symbols.trunc} {fold.foldedCount} 行已折叠（共 {fold.totalPhysical} 行）
                            </Text>
                          </Box>
                        ) : null
                      if (isSideEffect) {
                        return (
                          <>
                            {head.map((line, i) => (
                              <Box key={`h${i}`}>
                                <Gutter />
                                <DiffLine line={line} />
                              </Box>
                            ))}
                            {marker}
                            {tail.map((line, i) => (
                              <Box key={`t${i}`}>
                                <Gutter />
                                <DiffLine line={line} />
                              </Box>
                            ))}
                          </>
                        )
                      }
                      return (
                        <>
                          {head.length > 0 && (
                            <Box>
                              <Gutter />
                              <Text color={t.status === 'error' ? theme.error : undefined}>{head.join('\n')}</Text>
                            </Box>
                          )}
                          {marker}
                          {tail.length > 0 && (
                            <Box>
                              <Gutter />
                              <Text color={t.status === 'error' ? theme.error : undefined}>{tail.join('\n')}</Text>
                            </Box>
                          )}
                        </>
                      )
                    })()}
                  </>
                ) : (
                  <Box>
                    <Gutter />
                    <Text dimColor>
                      {symbols.foldCollapsed} {preview}
                      {content.length > preview.length
                        ? ` ${symbols.trunc}(${formatBytes(bytes)})`
                        : ''}
                    </Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )
      })}
      {!expanded && overflow > 0 && (
        <Box>
          <Gutter />
          <Text dimColor>还有 {overflow} 个工具</Text>
        </Box>
      )}
      {capped && (
        <Box>
          <Gutter />
          <Text dimColor>…还有 {hiddenTools} 个工具因终端预算折叠（Ctrl+O 展开 / /output 查看全文）</Text>
        </Box>
      )}
    </Box>
  )
}
