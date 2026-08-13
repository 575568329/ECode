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
  /** resolve（onConfirm→true / onCancel→false，loop 收到后继续或转 is_error） */
  resolve: (ok: boolean) => void
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
