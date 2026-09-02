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
import { memo, type ReactElement } from 'react'
import { Box, Text } from 'ink'
import { Markdown } from './Markdown.js'
import { ToolLine } from './ToolLine.js'
import { foldStreamText } from './stream.js'
import { MessageRow } from './MessageRow.js'
import { symbols } from './symbols.js'
import { WIDTH } from './layout.js'
import { timelineBudget } from './viewport.js'
import type { TimelineEntry } from '../protocol/timeline.js'

const LF = '\n'

/** 流式灰字占位（自 Conversation 迁入，活动流 B4——解循环引用；re-export 见 Conversation） */
export function GrayStreaming({ text, maxLines }: { text: string; maxLines?: number }): ReactElement {
  const cols = typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 80
  const { lines, folded, total } = foldStreamText(text, maxLines, Math.max(10, cols - 2))
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
  if (live) {
    return (
      <MessageRow>
        <GrayStreaming text={text} maxLines={maxLines} />
      </MessageRow>
    )
  }
  return (
    <MessageRow>
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

export function TimelineView({ timeline, lines, liveMaxLines }: TimelineViewProps): ReactElement {
  const { columns } = { columns: WIDTH.content(typeof process.stdout.columns === 'number' ? process.stdout.columns : 80) }
  const budget = timelineBudget(timeline, lines, columns, liveMaxLines)
  // live thinking 渲染跳过不占行（§5.5.6——只供 loading 行消费；终态行才计价）
  const visible = timeline.filter((e) => !(e.kind === 'thinking' && e.endedAt === undefined))
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
            ▲ 已折叠：本轮前段 {budget.foldedSummary.tools} 个调用 · {budget.foldedSummary.texts} 段文本（Ctrl+T 全程回看）
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
          return <TextEntry key={e.id} text={e.text} live={e.live} maxLines={liveMaxLines} />
        }
        if (e.kind === 'thinking') {
          return <ThinkingEntry key={e.id} durMs={e.durMs ?? 0} />
        }
        return (
          <ToolLine
            key={e.id}
            mode="dynamic"
            tool={{
              name: e.tool.name,
              id: e.tool.id,
              status: e.tool.status,
              ...(e.tool.at !== undefined ? { at: e.tool.at } : {}),
              ...(e.tool.digest !== undefined ? { digest: e.tool.digest } : {}),
              ...(e.tool.use !== undefined ? { use: e.tool.use as never } : {}),
              ...(e.tool.content !== undefined || e.tool.isError !== undefined
                ? { result: { type: 'tool_result' as const, tool_use_id: e.tool.id, content: e.tool.content ?? '', is_error: e.tool.isError === true } }
                : {}),
            }}
          />
        )
      })}
    </Box>
  )
}

/** 导出灰字折叠信息（调试/测试面；foldStreamText 在 GrayStreaming 内部消费） */
export function timelineFoldInfo(text: string, maxLines: number, columns: number): { total: number } {
  const { total } = foldStreamText(text, maxLines, WIDTH.body(columns))
  return { total }
}
