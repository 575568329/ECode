/**
 * 单工具行（活动流 B4，详设 v1.7 §5.1——从 ToolGroupView 抽出）：
 * 时间线（dynamic）与 Static 历史组（static）共用的行渲染器——两处观感同源。
 *
 * v1.7 管线审阅 P0-1：diff 封顶用**显式 mode 参数**——旧 `onToggle === undefined` proxy 判定
 * 在时间线路径失效（恒不传 onToggle=动态区 diff 变 Infinity 全量，50KB diff 每帧重画必 3J）。
 * mode='static'：副作用工具 diff 全量（scrollback 无限，2026-08-29「diff 必须显示全」）；
 * mode='dynamic'：副作用完成后自动展开但受 expandCap 封顶（轮末 Static 全量补偿）。
 */
import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { previewLine } from './toolview.js'
import { DiffLine } from './DiffLine.js'
import { theme } from './theme.js'
import { symbols, toolIcon } from './symbols.js'
import { foldLines, useViewport } from './viewport.js'
import { stripUntrustedAnsi } from '../protocol/sanitize.js'
import { GAP, INDENT, WIDTH } from './layout.js'
import type { ActiveTool } from './types.js'

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 展开输出 head-tail 上限绝对值（对齐 ToolGroupView EXPAND_CAP 语义） */
const EXPAND_CAP = 12

export interface ToolLineProps {
  tool: ActiveTool
  mode: 'dynamic' | 'static'
}

export function ToolLine({ tool, mode }: ToolLineProps): ReactElement {
  const { budget, columns } = useViewport()
  const expandCap = Math.min(EXPAND_CAP, Math.max(3, Math.floor(budget / 2)))
  const expandWidth = WIDTH.toolOutput(columns)
  const t = tool
  const digest = t.digest ?? (t.use !== undefined ? previewLine(JSON.stringify(t.use.input) ?? '') : '')
  const tail =
    t.status === 'error'
      ? { sym: symbols.error, color: theme.error }
      : t.status === 'done'
        ? { sym: symbols.success, color: theme.success }
        : null
  const contentRaw = t.result?.content ?? ''
  // 净化出口（审阅 S1 惯例平移）：工具输出=不可信面（读文件类注入主通道——OSC 52/OSC 8）
  const content = stripUntrustedAnsi(contentRaw)
  const hasOutput = content.length > 0 || (t.result?.blocks?.length ?? 0) > 0
  const bytes = Buffer.byteLength(contentRaw, 'utf8')
  const isSideEffect = t.name === 'edit_file' || t.name === 'write_file'
  // D15：副作用工具完成后 diff 自动展开（现状 ToolGroupView showFull 语义平移）；只读恒收起。
  // 行数封顶按 mode 区分（P0-1）：static=Infinity 全量；dynamic=expandCap（审阅 T6）
  const showFull = isSideEffect && t.status !== 'running'
  const foldCap = mode === 'static' ? Number.POSITIVE_INFINITY : expandCap
  const preview = previewLine(content)

  return (
    <Box flexDirection="column">
      <Box>
        {/* 行首图标列（D11 按类型：▢终端 ✎编辑 ⌕查阅；名称起于第 2 列=⎿ 悬挂列） */}
        <Box minWidth={INDENT.icon}>
          <Text dimColor>{toolIcon(t.name)}</Text>
        </Box>
        <Text bold>{t.name}</Text>
        {digest !== '' && (
          <Text dimColor>
            {' '}
            {t.status === 'running' && t.digest !== undefined ? `· 正在执行 ${t.digest}` : digest}
          </Text>
        )}
        {tail && <Text color={tail.color}> {tail.sym}</Text>}
      </Box>
      {hasOutput && (
        <Box flexDirection="column">
          {showFull ? (
            (() => {
              const fold = foldLines(content, foldCap, expandWidth, 'head-tail')
              const head = fold.visible.slice(0, fold.markerAt)
              const tailLines = fold.visible.slice(fold.markerAt)
              const marker = fold.foldedCount > 0 ? (
                <Text dimColor>
                  {symbols.trunc} {fold.foldedCount} 行已折叠（共 {fold.totalPhysical} 行）
                </Text>
              ) : null
              return (
                <Box marginTop={GAP.block / 2}>
                  <Box minWidth={INDENT.gutter}>
                    <Text dimColor>{'  ⎿  '}</Text>
                  </Box>
                  <Box flexDirection="column" flexShrink={1} flexGrow={1}>
                    <Text dimColor>
                      {symbols.foldExpanded} 输出 ({formatBytes(bytes)})
                      {t.at !== undefined ? ` · ${new Date(t.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}` : ''}
                    </Text>
                    {isSideEffect ? (
                      <>
                        {head.map((line, i) => (
                          <DiffLine key={`h${i}`} line={line} />
                        ))}
                        {marker}
                        {tailLines.map((line, i) => (
                          <DiffLine key={`t${i}`} line={line} />
                        ))}
                      </>
                    ) : (
                      <>
                        {head.length > 0 && (
                          <Text color={t.status === 'error' ? theme.error : undefined}>{head.join('\n')}</Text>
                        )}
                        {marker}
                        {tailLines.length > 0 && (
                          <Text color={t.status === 'error' ? theme.error : undefined}>{tailLines.join('\n')}</Text>
                        )}
                      </>
                    )}
                  </Box>
                </Box>
              )
            })()
          ) : (
            <Box marginTop={GAP.block / 2}>
              <Box minWidth={INDENT.gutter}>
                <Text dimColor>{'  ⎿  '}</Text>
              </Box>
              <Text dimColor>
                {symbols.foldCollapsed} {preview}
                {content.length > preview.length ? ` ${symbols.trunc}(${formatBytes(bytes)})` : ''}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
