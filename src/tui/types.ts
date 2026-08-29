/**
 * 最小 Static TUI 的类型定义（详设 2026-08-13 §4）。
 *
 * - ActiveState：动态区当前轮的活跃状态（分区累积，runLoop 结束才 commit）
 * - CommittedItem：Static 区已固化的历史片段（渐进 append，永不重绘）
 *
 * 动态区视觉顺序（用户定）：① 用户输入 → ② 工具合并块 → ③ 流式灰字 → ④ UI。
 * commit 时按 message.content 原序还原真实时序进 Static。
 */

import type { ToolUseBlock, ToolResultBlock } from '../core/types.js'

/** 动态区工具项（本轮内，执行中 or 已完成）。合并块展示，详见 ToolGroupView。 */
export interface ActiveTool {
  /** onToolStart 只给 name（use 此时未解析，P1-2）；onToolResult 后从 messagesRef 反查填入 */
  name: string
  use?: ToolUseBlock
  result?: ToolResultBlock
  status: 'running' | 'done' | 'error'
  /** F-06：开始时间戳——展开态输出头部显示 HH:MM，历史快照不再误读为当前状态
   *  （轮次号全链路成本大，任务书允许降级为纯时间戳；缺省不显示——Static 固化无此字段） */
  at?: number
}

/** 动态区当前轮活跃状态（分区累积，直到 runLoop 结束才 commit） */
export interface ActiveState {
  /** 本轮用户输入（顶部 ①，折叠到 2 行） */
  userInput: string
  /** 本轮所有工具（累积，合并块 ② 展示） */
  tools: ActiveTool[]
  /** 本轮流式文本（累积） */
  streamingText: string
  /** true=流式中（GrayStreaming 灰字 ③）；false=流式结束（Markdown 渲染，本轮仍在动态区可展开） */
  streaming: boolean
  /** 展开的工具 id（只对当前轮；commit 时清空 = 下一轮收起） */
  expandedTools: Set<string>
  /** 等待用户确认的副作用工具（非 null 时 ConfirmPrompt 渲染，loop 挂起；详设 §7） */
  confirm: ConfirmState | null
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

/** 创建空 ActiveState（初始 / commit 后 / clear 后） */
export function createActive(): ActiveState {
  return {
    userInput: '',
    tools: [],
    streamingText: '',
    streaming: false,
    expandedTools: new Set(),
    confirm: null,
  }
}

/**
 * 界面批 B1：单工具级展开的下一个选中（Ctrl+E 循环）。
 * 规则：在「未展开的 done 工具」中取第一个；全展开 → 空集（全收起重置）。
 * 单选展开（Set 只含一个）——行数入 V2 预算（ToolGroupView expandCap 钳制每个展开输出，
 * Conversation 展开态 maxTools=min(cap,1) 限制可见组数）。
 */
export function nextSingleExpand(tools: Array<{ use?: { id: string } }>, current: Set<string>): Set<string> {
  const dones = tools.filter((t) => t.use !== undefined) as Array<{ use: { id: string } }>
  if (dones.length === 0) return current
  const next = dones.find((t) => !current.has(t.use.id))
  if (next === undefined) return new Set()
  return new Set([next.use.id])
}
