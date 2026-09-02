import type { ReactElement } from 'react'
import { Markdown } from './Markdown.js'
import { GrayStreaming } from './Conversation.js'
import { MessageRow } from './MessageRow.js'
import { symbols } from './symbols.js'

/**
 * 助手消息（TUI 规范 §4.2/§7）：
 * - streaming：灰字占位（GrayStreaming，超行折叠）在图标槽右列
 * - committed：Markdown 全量渲染（代码高亮 / 表格 / 列表）在图标槽右列
 *
 * F-36：两态统一进 MessageRow 栅格——图标占 2 列槽，正文（含折行续行）从第 2 列起
 * （CC AssistantTextMessage BLACK_CIRCLE + minWidth=2 同构）。
 *
 * 活动流 D3 演进：2026-09-02 首拍「顶格（icon=''）」→ 同日二次翻案（用户真机观感：
 * 正文无图标、与后续工具行黏连难分）→ ◆ 占图标槽。流式与固化同图标——轮末动静零跳变。
 */
export function AssistantMessage({ text, streaming }: { text: string; streaming?: boolean }): ReactElement {
  if (streaming) {
    return (
      <MessageRow icon={symbols.assistant}>
        <GrayStreaming text={text} />
      </MessageRow>
    )
  }
  return (
    <MessageRow icon={symbols.assistant}>
      <Markdown text={text} />
    </MessageRow>
  )
}
