/**
 * 界面批 B2：transcript 写 scrollback——设计验证用例。
 *
 * 设计结论（5 行，见任务汇报）：Ink Static 输出即写原生 scrollback（与 CC classic 等效），
 * V4 轮末 commit 已把 assistant 全文 markdown 渲染进 Static；assistant-text 无截断
 * （messagesToCommitted 只截 user，10 行上限）。本文件钉这两个不变量：
 * 长文 assistant-text 原样进 committed；user 截断仅作用于 user。
 */
import { describe, it, expect } from 'vitest'
import { messagesToCommitted, truncateUserText } from '../../src/tui/commit.js'
import type { Message } from '../../src/core/types.js'

const longText = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行内容`).join('\n')

describe('B2 设计验证：assistant 全文进 Static（= 写 scrollback）', () => {
  it('长 assistant 文本不截断（200 行原样进 committed）', () => {
    const lines: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [{ type: 'text', text: longText }] },
    ]
    const items = messagesToCommitted(lines)
    const at = items.find((i) => i.kind === 'assistant-text')
    expect(at !== undefined && at.kind === 'assistant-text' && at.text === longText).toBe(true)
  })

  it('user 截断仅作用于 user（10 行上限，assistant 不受影响）', () => {
    const u = truncateUserText(longText)
    expect(u).toContain('已截断')
    expect(u.split('\n').length).toBeLessThanOrEqual(11)
    const lines: Message[] = [
      { role: 'user', content: [{ type: 'text', text: longText }] },
      { role: 'assistant', content: [{ type: 'text', text: longText }] },
    ]
    const items = messagesToCommitted(lines)
    const at = items.find((i) => i.kind === 'assistant-text')
    // assistant 侧不受 user 截断影响
    expect(at !== undefined && at.kind === 'assistant-text' && at.text === longText).toBe(true)
  })
})
