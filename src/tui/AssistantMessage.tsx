import type { ReactElement } from 'react'
import { Markdown } from './Markdown.js'
import { GrayStreaming } from './Conversation.js'
import { MessageRow } from './MessageRow.js'

/**
 * 助手消息（TUI 规范 §4.2/§7）：
 * - streaming：灰字占位（GrayStreaming，超行折叠）在圆点槽右列
 * - committed：Markdown 全量渲染（代码高亮 / 表格 / 列表）在圆点槽右列
 *
 * F-36：两态统一进 MessageRow 栅格——● 占 2 列槽，正文（含折行续行）从第 2 列起
 * （CC AssistantTextMessage BLACK_CIRCLE + minWidth=2 同构；此前正文第 0 列裸排是
 * 「图标都在最前面而文字顶格」的不齐根源）。
 *
 * 流式→提交切换：调用方把 streaming 从 true 切 false（M2 方案 A）。
 */
export function AssistantMessage({ text, streaming }: { text: string; streaming?: boolean }): ReactElement {
  if (streaming) {
    return (
      <MessageRow>
        <GrayStreaming text={text} />
      </MessageRow>
    )
  }
  return (
    <MessageRow>
      <Markdown text={text} />
    </MessageRow>
  )
}
