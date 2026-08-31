import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { mergeToolGroup, inputDigest, previewLine } from './toolview.js'
import { DiffLine } from './DiffLine.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { clipWidth, foldLines, useViewport } from './viewport.js'
import { stripUntrustedAnsi } from './sanitize.js'
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

/** 展开输出行数上限（M14-V2 §3.2：只读工具展开的 head-tail 上限——min(12, budget/2)）。
 *  副作用工具（edit_file/write_file）的 diff 不适用——2026-08-29 用户拍板「diff 必须显示全」，
 *  传 Infinity 全量渲染（见展开分支注）；全文超 50KB 由 F-39 工具层截断落盘兜底。 */
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
 * Static（历史 tool-group）：不传 expanded/onToggle——只读工具收起固化（▸ preview）；
 * 副作用工具（edit_file/write_file）固化后仍展开且 diff 全量渲染（2026-08-29 翻案：不显示
 * diff=黑盒，折半显示也不接受——「diff 必须显示全」）。
 */
interface ToolGroupViewProps {
  tools: ActiveTool[]
  /** 受控展开（Ctrl+O 全展）；默认 false（折叠） */
  expanded?: boolean
  /** 界面批 B1：单工具级展开 id 集（Ctrl+E 循环）——命中的工具独立展开看全文，不整组展开 */
  expandedIds?: Set<string>
  /** 本轮是否结束（runLoop 完成）。副作用工具进行中折叠省空间（本轮可能多 edit）；
   *  done=undefined（Static 固化）同样展开 diff——见 showFull 处 2026-08-29 翻案注 */
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
  // 审阅 P2：degraded 分支曾渲出「● 0 个工具」空组头（maxTools=0 时 visible 为空仍出表头）
  // ——maxTools=0 渲单行折叠提示即返回
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
    // F-36：间距统一 marginTop 级联（去 marginBottom——后继 MessageRow/用户消息/composer
    // 各自 marginTop=1，双 margin 会叠成 2 空行；CC addMargin?1:0 同节奏）
    <Box flexDirection="column" marginTop={GAP.block}>
      <Box>
        <Box minWidth={INDENT.icon}>
          <Text color={theme.tool}>{symbols.tool}</Text>
        </Box>
        {/* 2026-08-29 用户点名：图标槽后不得再垫字面量空格——● 槽 2 列后内容恒从第 2 列起
            （「个工具」与文件名列表之间的分隔空格保留，那是行内语义间距非栅格） */}
        <Text bold color={theme.tool}>
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
        // 审阅 S1：digest（模型生成的参数摘要）同过净化出口
        const digest = t.use ? stripUntrustedAnsi(inputDigest(t.use.input)) : ''
        const tail =
          t.status === 'error'
            ? { sym: symbols.error, color: theme.error }
            : t.status === 'done'
              ? { sym: symbols.success, color: theme.success }
              : null // running：无 tail（等 done 才 ✓/✗）
        const contentRaw = t.result?.content ?? ''
        // 审阅 S1：不可信内容净化在渲染出口（工具输出/diff 是读文件类注入的主通道——
        // Ink 内置净化保留 OSC 全家族，OSC 52 覆写剪贴板/OSC 8 链接欺骗可直达终端）
        const content = stripUntrustedAnsi(contentRaw)
        const mediaBlocks = t.result?.blocks ?? []
        const hasOutput = content.length > 0 || mediaBlocks.length > 0
        const bytes = Buffer.byteLength(contentRaw, 'utf8')
        // 副作用工具（edit_file/write_file）默认展开输出（直接显示 diff/content），
        // 只读工具默认折叠（▸ preview）；Ctrl+O 全展开覆盖
        const isSideEffect = t.name === 'edit_file' || t.name === 'write_file'
        // 副作用工具（edit_file/write_file）进行中（done=false）折叠省空间（本轮可能多 edit 连发）；
        // 轮末（done=true）与 Static 固化（done=undefined）都展开 diff——2026-08-29 用户翻案
        // 「改动了文件但不显示 diff 纯纯黑盒」：旧拍板「历史全收起」让 acceptEdits 下的编辑过程
        // 完全不可见（V4 轮末即 commit，done=true 展开实际活不过一帧就被 Static 吞掉）。
        // 界面批 B1：expandedIds 命中的工具单选展开（Ctrl+E 循环，独立于组级 expanded）
        const showFull = expanded || (isSideEffect && done !== false) || (expandedIds !== undefined && t.use !== undefined && expandedIds.has(t.use.id))
        // 审阅 T6：diff Infinity 全量只给 Static 固化路径（onToggle 缺省）——动态区 error 轮
        // 无 completed 帧，整份 50KB diff 常驻动态区每帧重画必 overflow 3J；V4 轮末即 commit
        // 下动态展开只活一帧，封顶无感知损失，全文 Ctrl+T 可看
        const fullDiffUnlimited = isSideEffect && onToggle === undefined
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
            {/* 2026-08-30：todo 清单移至输入区上方常驻面板（TodoPanel——对标 CC/harness/opencode
                「清单不进 transcript」共识），对话流只留一行完成度摘要作时序痕迹 */}
            {hasOutput && (
              <Box flexDirection="column">
                {showFull ? (
                  (() => {
                    // M14-V2：展开全文 head-tail 物理行折叠（头 3 定位 + 尾最新）——只读工具适用。
                    // 2026-08-29 用户再拍板「diff 必须显示全」：Static 固化路径副作用工具传 Infinity
                    // 不限行数（同一条 wrapAnsi 硬折行路径保 ⎿ 悬挂缩进对齐；极端体积由上游 50KB 工具
                    // 结果截断兜底，F-39 超限落盘 Ctrl+T 可回看），动态区走 expandCap（审阅 T6）
                    const fold = foldLines(
                      content,
                      fullDiffUnlimited ? Number.POSITIVE_INFINITY : expandCap,
                      expandWidth,
                      'head-tail',
                    )
                    const head = fold.visible.slice(0, fold.markerAt)
                    const tail = fold.visible.slice(fold.markerAt)
                    // F-43：标题+折叠提示+全文整体收进「单 ⎿ + 内容列」——CC MessageResponse
                    // 同构（一个工具结果一个 ⎿，续行悬挂内容列），不再每行重复 Gutter 满屏 ⎿。
                    // 内容列 flex 宽 = 展开宽度约束，diff ± 着色（DiffLine）不受影响。
                    const marker = fold.foldedCount > 0 ? (
                      <Text dimColor>
                        {symbols.trunc} {fold.foldedCount} 行已折叠（共 {fold.totalPhysical} 行）
                      </Text>
                    ) : null
                    return (
                      <Box>
                        <Gutter />
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
                              {tail.map((line, i) => (
                                <DiffLine key={`t${i}`} line={line} />
                              ))}
                            </>
                          ) : (
                            <>
                              {head.length > 0 && (
                                <Text color={t.status === 'error' ? theme.error : undefined}>{head.join('\n')}</Text>
                              )}
                              {marker}
                              {tail.length > 0 && (
                                <Text color={t.status === 'error' ? theme.error : undefined}>{tail.join('\n')}</Text>
                              )}
                            </>
                          )}
                        </Box>
                      </Box>
                    )
                  })()
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
          {/* D7：Ctrl+O 已随 F-50 废除——全文入口只剩 /output（Ctrl+T 是空闲态全屏查看器） */}
          <Text dimColor>…还有 {hiddenTools} 个工具因终端预算折叠（/output 查看全文）</Text>
        </Box>
      )}
    </Box>
  )
}
