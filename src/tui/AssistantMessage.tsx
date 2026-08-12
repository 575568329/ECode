import type { ReactElement } from 'react'
import { Markdown } from './Markdown.js'
import { GrayStreaming } from './Conversation.js'

/**
 * 助手消息（TUI 规范 §4.2/§7）：
 * - streaming：灰字占位（GrayStreaming，超 5 行折叠尾部）
 * - committed：Markdown 全量渲染（代码高亮 / 表格 / 列表）
 *
 * 流式→提交切换：调用方把 streaming 从 true 切 false（M2 方案 A）。
 */
export function AssistantMessage({ text, streaming }: { text: string; streaming?: boolean }): ReactElement {
  if (streaming) return <GrayStreaming text={text} />
  return <Markdown text={text} />
}
