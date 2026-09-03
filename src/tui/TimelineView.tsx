/**
 * 轮内时间线视图（活动流 B4，详设 v1.7 §5.1/§5.5）：
 * 文本/思考/工具按到达序一条流渲染——替代旧「工具合并块+流式文本」固定槽位。
 *
 * 折叠（§5.5 状态机，五状态在 Conversation/alloc 层驱动；本组件承载 S0/S1）：
 * 自底向上（最新→最老）累加实占，超预算的头部条目整体折叠为一行摘要——
 * 「显示最新的，其余的折叠」需求本体。单价公式含 diff 附属行（v1.7 渲染审阅 P0-1：
 * 标题行+marker 行漏算 = 每可见副作用条目系统性少算 2 行，18 行终端 4 edit 直通 3J）。
 *
 * 终态文本段形态（v1.7 管线审阅 P0-2）：Markdown 渲染行数不可精确预估（heading/表格/代码块
 * 各异）——最新一个终态段渲 Markdown（保守系数估行，超限整段降级为提示行，绝不行级截断），
 * 更老的终态段直接降级提示行（1 行精确计价）；live 段灰字 foldLines 精确计价。
 *
 * 性能（渲染审阅 P1-2 四件套之三）：条目级 React.memo——reducer 未动条目引用恒等（B3 锚）。
 */
import { memo, useRef, type ReactElement } from 'react'
import { Box, Text } from 'ink'
import { Markdown } from './Markdown.js'
import { ToolLine } from './ToolLine.js'
import { foldStreamText, type StreamFoldCacheBox } from './stream.js'
import { useViewport } from './viewport.js'
import { collapseSameToolRuns } from './viewport.js'
import { MessageRow } from './MessageRow.js'
import { symbols } from './symbols.js'
import { WIDTH } from './layout.js'
import { timelineBudget, liveWindowLines } from './viewport.js'
import type { TimelineEntry } from '../protocol/timeline.js'

const LF = '\n'

/** 流式灰字占位（自 Conversation 迁入，活动流 B4——解循环引用；re-export 见 Conversation）。
 *  R2/P1-5：恢复 useViewport 订阅 resize——memo 条目下直读 stdout 会在变窄窗口按旧宽
 *  折叠（实际行数超 maxLines 破预算），迁移时丢的订阅补回。 */
export function GrayStreaming({ text, maxLines }: { text: string; maxLines?: number }): ReactElement {
  const { columns } = useViewport()
  // 批2a（P1-A）：增量折叠缓存——live 条目 text 每 delta 换引用（memo 恒 miss 是设计内），
  // 每 delta 全文重 wrap 的 O(n²) 由缓存消解（每 delta 只 wrap 新增字符）；resize 换宽自动重算
  const cacheRef = useRef<StreamFoldCacheBox>({ current: null })
  const { lines, folded, total } = foldStreamText(text, maxLines, WIDTH.body(columns), cacheRef.current)
  return (
    <Box flexDirection="column">
      {folded > 0 && <Text dimColor>↑ {folded} 行已折叠（共 {total} 行）</Text>}
      <Text dimColor>{lines.join(LF)}</Text>
    </Box>
  )
}

interface TimelineViewProps {
  timeline: TimelineEntry[]
  /** timeline 总行预算（allocateDynamic.timelineLines——折叠线累加上限） */
  lines: number
  /** 流式区（live text 段）行上限（allocateDynamic.streamMaxLines——灰字折叠窗） */
  liveMaxLines: number
}

/** 单条目 memo 包裹（未动条目引用恒等 → 跳过重渲；delta 高频下防全量重跑 markdown/fold） */
const TextEntry = memo(function TextEntry({ text, live, maxLines }: { text: string; live: boolean; maxLines: number }): ReactElement {
  // D3 二次翻案（2026-09-02 用户观感）：正文行 ◆ 占图标槽——live 与终态同图标，轮末零跳变
  if (live) {
    return (
      <MessageRow icon={symbols.assistant}>
        <GrayStreaming text={text} maxLines={maxLines} />
      </MessageRow>
    )
  }
  return (
    <MessageRow icon={symbols.assistant}>
      <Markdown text={text} />
    </MessageRow>
  )
})

const ThinkingEntry = memo(function ThinkingEntry({ durMs }: { durMs: number }): ReactElement {
  return (
    <MessageRow icon={symbols.thinking} dim>
      <Text dimColor>思考 · 持续了 {Math.max(1, Math.round(durMs / 1000))} 秒</Text>
    </MessageRow>
  )
})

/** 终态降级提示行（老终态段固定形态；最新终态段超预算时同款） */
const FoldedTextEntry = memo(function FoldedTextEntry({ chars }: { chars: number }): ReactElement {
  return (
    <MessageRow icon="" dim>
      <Text dimColor>⋯ 本段 {chars} 字已折叠（Ctrl+T 全程回看）</Text>
    </MessageRow>
  )
})

/** 同名工具 run 折叠摘要行（2026-09-03 拍板：N 连发同名工具只保留最新完整条） */
const ToolRunRow = memo(function ToolRunRow({ name, count, errors }: { name: string; count: number; errors: number }): ReactElement {
  return (
    <MessageRow icon="" dim>
      <Text dimColor>
        {symbols.folded} {name} ×{count} 已折叠{errors > 0 ? ` · ${errors} 失败` : ''}（Ctrl+T 全程）
      </Text>
    </MessageRow>
  )
})

export function TimelineView({ timeline, lines, liveMaxLines }: TimelineViewProps): ReactElement {
  const { columns } = useViewport()
  // 同名 run 折叠先于计价（预算与渲染同源——折叠条按 2 行计，不再按 N×3 虚计触发头部折叠）
  // live thinking 滤除与折叠同序执行（下标空间一致；budget 内的再滤除幂等）
  const visible = collapseSameToolRuns(
    timeline.filter((e) => !(e.kind === 'thinking' && e.endedAt === undefined)),
  )
  const budget = timelineBudget(visible, lines, columns, liveMaxLines)
  const lastFinalTextIdx = (() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      const e = visible[i]
      if (e.kind === 'text' && !e.live) return i
    }
    return -1
  })()

  return (
    <Box flexDirection="column">
      {budget.foldedSummary !== null && (
        <MessageRow icon="" dim>
          <Text dimColor>
            {symbols.folded} 已折叠：本轮前段 {budget.foldedSummary.tools} 个调用 · {budget.foldedSummary.texts} 段文本（Ctrl+T 全程回看）
          </Text>
        </MessageRow>
      )}
      {visible.map((e, i) => {
        if (i < budget.visibleFrom) return null
        if (e.kind === 'text') {
          // 老终态段直接降级（精确计价 1 行）；最新终态段 Markdown，超估行降级（渲染审阅 P0-2 三类策略）
          if (!e.live && i !== lastFinalTextIdx) {
            return <FoldedTextEntry key={e.id} chars={e.text.length} />
          }
          if (!e.live && budget.finalTextEstimate !== null && i === lastFinalTextIdx && budget.finalTextEstimate > budget.finalTextCap) {
            return <FoldedTextEntry key={e.id} chars={e.text.length} />
          }
          {/* 审阅修复：渲染窗与计价同源（liveWindowLines）——原用未压缩 liveMaxLines 致帧高越界 */}
          return <TextEntry key={e.id} text={e.text} live={e.live} maxLines={liveWindowLines(liveMaxLines, Math.floor(lines))} />
        }
        if (e.kind === 'thinking') {
          return <ThinkingEntry key={e.id} durMs={e.durMs ?? 0} />
        }
        if (e.kind === 'tool-run') {
          return <ToolRunRow key={e.id} name={e.name} count={e.count} errors={e.errors} />
        }
        return <TimelineToolLine key={e.id} entry={e} />
      })}
    </Box>
  )
}

/**
 * 批2a（P1-A）：工具条目 memo 门——协议 timeline → ActiveTool 的形状转换原先在
 * TimelineView 每帧内联做（每帧新对象 → ToolLine 即便 memo 也恒 miss，可见工具条目
 * 每帧重跑 strip/digest/preview/fold）。以**条目对象**为门：timeline reducer 保证未动
 * 条目引用恒等（B3 锚），转换收进 memo 子组件内部——未动条目零重渲。
 */
const TimelineToolLine = memo(function TimelineToolLine({ entry }: { entry: TimelineEntry }): ReactElement | null {
  if (entry.kind !== 'tool') return null // 联合类型收窄（TimelineView 调用处已按 kind 分流，此处防御）
  const t = entry.tool
  return (
    <ToolLine
      mode="dynamic"
      tool={{
        name: t.name,
        id: t.id,
        status: t.status,
        ...(t.at !== undefined ? { at: t.at } : {}),
        ...(t.digest !== undefined ? { digest: t.digest } : {}),
        ...(t.use !== undefined ? { use: t.use as never } : {}),
        ...(t.content !== undefined || t.isError !== undefined
          ? { result: { type: 'tool_result' as const, tool_use_id: t.id, content: t.content ?? '', is_error: t.isError === true } }
          : {}),
      }}
    />
  )
})

/** 导出灰字折叠信息（调试/测试面；foldStreamText 在 GrayStreaming 内部消费） */
export function timelineFoldInfo(text: string, maxLines: number, columns: number): { total: number } {
  const { total } = foldStreamText(text, maxLines, WIDTH.body(columns))
  return { total }
}
