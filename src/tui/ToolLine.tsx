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
import { makeToolDigest } from '../protocol/toolDigest.js'
import { GAP, INDENT, WIDTH } from './layout.js'
import type { ActiveTool } from './types.js'

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 展开输出 head-tail 上限绝对值（对齐 ToolGroupView EXPAND_CAP 语义） */
const EXPAND_CAP = 12

/** 折行结果缓存（LRU 16 条——OutputViewer cachedWrap 同款；键=内容长度+宽+cap 校验） */
const foldCache = new Map<string, { len: number; width: number; cap: number; fold: ReturnType<typeof foldLines> }>()
function foldToolOutput(content: string, cap: number, width: number): ReturnType<typeof foldLines> {
  const hit = foldCache.get(content)
  if (hit !== undefined && hit.len === content.length && hit.width === width && hit.cap === cap) return hit.fold
  const fold = foldLines(content, cap, width, 'head-tail')
  if (foldCache.size >= 16) {
    const oldest = foldCache.keys().next().value
    if (oldest !== undefined) foldCache.delete(oldest)
  }
  foldCache.set(content, { len: content.length, width, cap, fold })
  return fold
}

export interface ToolLineProps {
  tool: ActiveTool
  mode: 'dynamic' | 'static'
}

export function ToolLine({ tool, mode }: ToolLineProps): ReactElement {
  const { budget, columns } = useViewport()
  const expandCap = Math.min(EXPAND_CAP, Math.max(3, Math.floor(budget / 2)))
  const expandWidth = WIDTH.toolOutput(columns)
  const t = tool
  // G1：digest 单源 makeToolDigest（protocol 三方同规则——fallback 不再本地 JSON 串）；
  // todo 特化（M11-P6 平移）：digest 位显示完成度
  const todoItems =
    t.name === 'todo' && t.use
      ? ((t.use.input as { todos?: Array<{ status: string }> }).todos ?? [])
      : []
  const digest =
    todoItems.length > 0
      ? `${todoItems.filter((x) => x.status === 'completed').length}/${todoItems.length} 完成`
      : (t.digest ?? (t.use !== undefined ? makeToolDigest(t.name, t.use.input) : ''))
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
  // 动态宽度（用户拍板 2026-09-02）：viewport 列宽（共享 resize 监听，真 pty 下=终端实际宽）
  // −左侧图标/悬挂缩进（≈10 列），下限 80 保底——收起预览恒占 1 行（与折叠行预算正交），
  // 宽终端多显示；Static 打印时刻定格
  const preview = previewLine(content, Math.max(80, columns - 10))

  return (
    <Box flexDirection="column" marginTop={GAP.block}>
      {/* 块间节奏（2026-09-02 用户观感拍板）：空行移到块顶——正文/上一块的 ⎿ 与工具行拉开
          （原空行在标题与 ⎿ 之间=块内紧块间黏的反节奏）；总行数不变（entryCost 计价零改动） */}
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
              // G+ 性能四件套之三：diff/输出折行结果缓存（cachedWrap 同款键校验——length+width+cap，
              // 内容变化自然 miss；D15 自动展开下每 delta 帧全量重跑 wrap-ansi 是帧级开销主源）
              const fold = foldToolOutput(content, foldCap, expandWidth)
              const head = fold.visible.slice(0, fold.markerAt)
              const tailLines = fold.visible.slice(fold.markerAt)
              const marker = fold.foldedCount > 0 ? (
                <Text dimColor>
                  {symbols.trunc} {fold.foldedCount} 行已折叠（共 {fold.totalPhysical} 行）
                </Text>
              ) : null
              return (
                <Box>
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
            <Box>
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
