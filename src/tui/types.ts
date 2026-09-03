/**
 * 最小 Static TUI 的类型定义（详设 2026-08-13 §4；活动流 B4 改造）。
 *
 * - ActiveState：动态区当前轮的活跃状态（**TurnTimeline 时间线**——文本/思考/工具按到达序一条流，
 *   替代旧 tools+streamingText 固定槽位；归约收口 protocol/timeline.ts）
 * - CommittedItem：Static 区已固化的历史片段（渐进 append，永不重绘）
 */

import type { ToolUseBlock, ToolResultBlock } from '../core/types.js'
import type { TimelineEntry } from '../protocol/timeline.js'

/** 动态区工具项（TimelineTool 的 TUI 视图形态——ToolLine 消费） */
export interface ActiveTool {
  name: string
  id?: string
  use?: ToolUseBlock
  result?: ToolResultBlock
  status: 'running' | 'done' | 'error'
  /** F-06：开始时间戳——展开态输出头部显示 HH:MM，历史快照不再误读为当前状态 */
  at?: number
  /** 活动流：item/executing 帧回填（运行行/loading 行「正在执行 <命令>」） */
  digest?: string
}

/** 动态区当前轮活跃状态（时间线累积，直到 runLoop 结束才 commit） */
export interface ActiveState {
  /** 本轮用户输入（顶部，折叠到 2 行） */
  userInput: string
  /** 轮内时间线（文本/思考/工具按序一条流——替代 tools+streamingText） */
  timeline: TimelineEntry[]
  /** true=轮运行中（轮级态：degraded/清空时机判断用） */
  streaming: boolean
  /** 等待用户确认的副作用工具（非 null 时 ConfirmPrompt 渲染，loop 挂起；详设 §7） */
  confirm: ConfirmState | null
}

/** timeline → 最新 live text 段文本（旧 streamingText 消费点的等价派生；无 live 段取最后终态段） */
export function liveTextOf(timeline: TimelineEntry[]): string {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (e.kind === 'text') return e.text
  }
  return ''
}

/** timeline → 工具条目视图（旧 active.tools 消费点的等价派生） */
export function toolsOf(timeline: TimelineEntry[]): ActiveTool[] {
  return timeline
    .filter((e): e is Extract<TimelineEntry, { kind: 'tool' }> => e.kind === 'tool')
    .map((e) => {
      const t = e.tool
      return {
        name: t.name,
        id: t.id,
        status: t.status,
        ...(t.at !== undefined ? { at: t.at } : {}),
        ...(t.digest !== undefined ? { digest: t.digest } : {}),
        ...(t.use !== undefined ? { use: t.use as ToolUseBlock } : {}),
        ...(t.content !== undefined || t.isError !== undefined
          ? { result: { type: 'tool_result' as const, tool_use_id: t.id, content: t.content ?? '', is_error: t.isError === true } }
          : {}),
      }
    })
}

/** confirm 弹窗状态（loop await confirm 期间挂起，onConfirm/onCancel resolve） */
export interface ConfirmState {
  use: ToolUseBlock
  /** 预览内容（edit_file=unified diff 文本；write_file=新增片段；bash=命令字符串；着色由 ConfirmPrompt 负责） */
  preview: string
  /** resolve（onConfirm→true / onCancel→false，loop 收到后继续或转 is_error）；
   *  always=true 表示用户选了「本会话记住」（MCP server 级放行，M6 v3 P1-3——loop 不感知，TuiApp 侧记前缀） */
  resolve: (ok: boolean, always?: boolean, reason?: string) => void
  /** 第三键文案（M9-P5 通用化：缺省仅 MCP 工具显示"本会话记住"；传入则显示该文案并启用 a 键） */
  rememberLabel?: string
}

/** Static 区已固化的工具调用（必有 result） */
export interface CommittedToolCall {
  use: ToolUseBlock
  result: ToolResultBlock
}

/** Static 区渲染单元（渐进 append，永不重绘） */
export type CommittedItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant-text'; id: string; text: string }
  | { kind: 'tool-group'; id: string; calls: CommittedToolCall[] }
  /** M5 压缩点标记：上方 removedCount 条已摘要进模型上下文（UI 仍显示全量原文） */
  | { kind: 'compacted'; id: string; removedCount: number }
  /** M9-P2：/rewind 回退点标记（下方消息不再进模型上下文，原文仍显示） */
  | { kind: 'rewind'; id: string; seq: number }
  /** 活动流 D4-B：思考行（ThinkingLine 消化——Static 渲染折叠行，正文在 Ctrl+T 面板） */
  | { kind: 'thinking'; id: string; durMs: number; text: string }
  /** 审查器附注卡（session.ts 拼进 user input 的合成指令——不冒充用户气泡，
   *  渲染为系统提示行；全文在 transcript（Ctrl+T 面板）可回看 */
  | { kind: 'review-card'; id: string; chars: number }
  /** 机器消息系统行（2026-09-03 归属根治：task 通知/loop-guard/quality/插话——按 meta 分流，
   *  不冒充用户气泡；全文 transcript 可回看） */
  | { kind: 'system-note'; id: string; text: string }

/** 创建空 ActiveState（初始 / commit 后 / clear 后） */
export function createActive(): ActiveState {
  return {
    userInput: '',
    timeline: [],
    streaming: false,
    confirm: null,
  }
}
