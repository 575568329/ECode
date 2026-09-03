/**
 * 界面批 B2 + 输入体验批（2026-08-31）：transcript 写 scrollback——设计验证用例。
 *
 * 设计结论：assistant 与 user 文本均全文进 Static（Ink Static 输出即写原生 scrollback，
 * append-only 天然无超屏）。输入体验批拍板「用户消息锁死」——去掉 user 10 行截断
 * （旧 truncateUserText 会在固化时数据级丢弃 7 行以后内容且无恢复入口，用户回看不到
 * 自己发送的全文）。本文件钉：长文 assistant 与 user 均原样进 committed。
 */
import { describe, it, expect } from 'vitest'
import { messagesToCommitted } from '../../src/tui/commit.js'
import type { Message } from '../../src/core/types.js'

// fixture 加长（审阅 1b）：单行混入足量字符使总长 >1000——低于历史 preview(300)/任何新
// 截断阈值的 fixture 会让「全文不截断」断言假绿
const longText = Array.from(
  { length: 200 },
  (_, i) => `第 ${i + 1} 行内容，附足够长度使任何截断阈值都无所遁形，尾部校验串 ${String(i + 1).padStart(3, '0')}END`,
).join('\n')

describe('B2 + 输入体验批：全文进 Static（= 写 scrollback）', () => {
  it('长 assistant 文本不截断（200 行原样进 committed）', () => {
    const lines: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [{ type: 'text', text: longText }] },
    ]
    const items = messagesToCommitted(lines)
    const at = items.find((i) => i.kind === 'assistant-text')
    expect(at !== undefined && at.kind === 'assistant-text' && at.text === longText).toBe(true)
  })

  it('用户消息全文进 committed（锁死不截断——输入体验批）', () => {
    const lines: Message[] = [{ role: 'user', content: [{ type: 'text', text: longText }] }]
    const items = messagesToCommitted(lines)
    const u = items.find((i) => i.kind === 'user')
    expect(u !== undefined && u.kind === 'user' && u.text === longText).toBe(true)
    expect(u?.text).not.toContain('已截断')
  })

  it('续写指令（meta:continue）不渲染成用户气泡——e268776 起标记结构化，字符串形态即普通用户消息', () => {
    const lines: Message[] = [
      {
        role: 'user',
        meta: { kind: 'continue' },
        content: [
          {
            type: 'text',
            text: '输出已达 max_tokens 上限被截断。请从中断处直接续写：不要道歉、不要复述已写内容，必要时把剩余工作拆成更小的步骤分批输出。',
          },
        ],
      },
    ]
    const items = messagesToCommitted(lines)
    expect(items.find((i) => i.kind === 'user')).toBeUndefined()
  })
})
