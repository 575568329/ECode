/**
 * W-5 消息操作注册表（批 2）：每个操作一个纯工厂条目（key/label/run），UI 只消费数组。
 * 新增操作（导出/引用/TTS…）只增条目零侵入——lobe-chat defineAction 模式的轻量版。
 */
import type { ChatEntry } from './store'

export interface MessageActionContext {
  /** 写剪贴板（Conversation 层负责降级容错） */
  copy: (text: string) => void
  /** 以该文本重新发起一轮（同会话 prompt） */
  resend: (text: string) => void
}

export interface MessageAction {
  key: string
  label: string
  title: string
  run: () => void
}

/** 按条目类型产出可用操作：助手=复制；用户=复制+重发；工具/system 无文本操作 */
export function buildMessageActions(entry: Pick<ChatEntry, 'kind' | 'text'>, ctx: MessageActionContext): MessageAction[] {
  const actions: MessageAction[] = [
    {
      key: 'copy',
      label: '复制',
      title: '复制文本',
      run: () => ctx.copy(entry.text),
    },
  ]
  if (entry.kind === 'user') {
    actions.push({
      key: 'resend',
      label: '重发',
      title: '以此消息重新发起一轮',
      run: () => ctx.resend(entry.text),
    })
  }
  return actions
}
