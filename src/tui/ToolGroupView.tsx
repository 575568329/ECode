import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { mergeToolGroup, inputDigest, previewLine } from './toolview.js'
import { DiffLine } from './DiffLine.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import type { ActiveTool } from './types.js'

/** 字节数格式化（B/KB/MB）。与 ToolCallView 一致，复用同一展示约定。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

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
  /** 本轮是否结束（runLoop 完成）。副作用工具仅在本轮结束时展开 diff，进行中折叠省空间（本轮可能多 edit） */
  done?: boolean
  onToggle?: () => void
}

export function ToolGroupView({ tools, expanded = false, done, onToggle }: ToolGroupViewProps): ReactElement {
  if (tools.length === 0) return <Box />
  const { count, visible, overflow } = mergeToolGroup(tools)
  const shown = expanded ? tools : visible
  const namesPreview = visible.map((t) => t.name).join(', ')
  const headerSuffix = overflow > 0 ? ` ${symbols.trunc} +${overflow} 个` : ''

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
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
        const content = t.result?.content ?? ''
        const mediaBlocks = t.result?.blocks ?? []
        const hasOutput = content.length > 0 || mediaBlocks.length > 0
        const bytes = Buffer.byteLength(content, 'utf8')
        // 副作用工具（edit_file/write_file）默认展开输出（直接显示 diff/content），
        // 只读工具默认折叠（▸ preview）；Ctrl+O 全展开覆盖
        const isSideEffect = t.name === 'edit_file' || t.name === 'write_file'
        // 副作用工具仅在本轮结束（done）时展开 diff；进行中折叠省空间（本轮可能多 edit）；
        // Static done=undefined → 展开（事后完整看）；Ctrl+O（expanded）强制全展
        const showFull = expanded || (isSideEffect && done !== false)
        const preview = previewLine(content)
        // M11-P6 todo 特化：digest 显示完成度，展开态逐项 ASCII 状态符（[x]/[->]/[ ]——ambiguous 宽度教训只用 ASCII）
        const isTodo = t.name === 'todo'
        const todoItems =
          isTodo && t.use
            ? ((t.use.input as { todos?: Array<{ content: string; status: string }> }).todos ?? [])
            : []
        const todoDone = todoItems.filter((x) => x.status === 'completed').length
        return (
          <Box key={id} flexDirection="column" paddingLeft={3}>
            <Box>
              <Text dimColor>{t.name}</Text>
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
                    <Text
                      color={x.status === 'in_progress' ? theme.info : undefined}
                      bold={x.status === 'in_progress'}
                    >
                      {' '}
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
                    <Text dimColor>
                      {'  '}
                      {symbols.foldExpanded} 输出 ({formatBytes(bytes)})
                    </Text>
                    {isSideEffect ? (
                      // edit_file/write_file：按行着色（diff 风格：- 红 / + 绿 / @@ 蓝）
                      content.split('\n').map((line, i) => (
                        <Box key={i}>
                          <DiffLine line={line} />
                        </Box>
                      ))
                    ) : (
                      <Text color={t.status === 'error' ? theme.error : undefined}>
                        {content}
                      </Text>
                    )}
                  </>
                ) : (
                  <Text dimColor>
                    {'  '}
                    {symbols.foldCollapsed} {preview}
                    {content.length > preview.length
                      ? ` ${symbols.trunc}(${formatBytes(bytes)})`
                      : ''}
                  </Text>
                )}
              </Box>
            )}
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
