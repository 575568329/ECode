import { describe, it, expect } from 'vitest'
import { messagesToCommitted, findUse } from '../../src/tui/commit.js'
import type { HistoryLine, Message, ToolUseBlock, ToolResultBlock, TextBlock } from '../../src/core/types.js'

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}
function asstText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}
function useBlock(id: string, name: string): ToolUseBlock {
  return { type: 'tool_use', id, name, input: {} }
}
function resultBlock(id: string, content = 'ok', isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError }
}

describe('messagesToCommitted', () => {
  it('user message → CommittedItem user', () => {
    const items = messagesToCommitted([userText('你好')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', text: '你好' })
  })

  it('assistant text → assistant-text', () => {
    const items = messagesToCommitted([asstText('回答')])
    expect(items[0]).toMatchObject({ kind: 'assistant-text', text: '回答' })
  })

  it('text/tool 交错保留原序（text1 → tool → text2，不合并 text）', () => {
    const messages: Message[] = [
      userText('q'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'text1' } as TextBlock, useBlock('t1', 'bash')],
      },
      { role: 'user', content: [resultBlock('t1')] },
      asstText('text2'),
    ]
    const items = messagesToCommitted(messages)
    // 关键：原序 user → text1 → tool-group → text2（不把 text1/text2 合并）
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'assistant-text',
      'tool-group',
      'assistant-text',
    ])
    const tg = items[2]
    expect(tg.kind).toBe('tool-group')
    if (tg.kind === 'tool-group') {
      expect(tg.calls).toHaveLength(1)
      expect(tg.calls[0].use.id).toBe('t1')
      expect(tg.calls[0].result.content).toBe('ok')
    }
  })

  it('连续 tool_use 合并一个 tool-group', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [useBlock('t1', 'a'), useBlock('t2', 'b')] },
      { role: 'user', content: [resultBlock('t1'), resultBlock('t2')] },
    ]
    const items = messagesToCommitted(messages)
    const groups = items.filter((i) => i.kind === 'tool-group')
    expect(groups).toHaveLength(1)
    if (groups[0].kind === 'tool-group') {
      expect(groups[0].calls).toHaveLength(2)
    }
  })

  it('orphan tool（无 tool_result）补「（已中断）」终态（P2-A）', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [useBlock('t1', 'bash')] },
      // 无 tool_result（中断场景）
    ]
    const items = messagesToCommitted(messages)
    const tg = items[0]
    expect(tg.kind).toBe('tool-group')
    if (tg.kind === 'tool-group') {
      expect(tg.calls[0].result.content).toBe('（已中断）')
      expect(tg.calls[0].result.is_error).toBe(true)
    }
  })

  it('空 messages → 空数组', () => {
    expect(messagesToCommitted([])).toEqual([])
  })
})

describe('findUse', () => {
  it('按 id 反查（从末尾找 last assistant）', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [useBlock('old', 'x')] },
      { role: 'assistant', content: [useBlock('t1', 'bash')] },
    ]
    const u = findUse(messages, 't1')
    expect(u?.name).toBe('bash')
  })

  it('找不到返回 undefined', () => {
    expect(findUse([], 'x')).toBeUndefined()
  })
})

describe('boundary 适配（M5 P5：HistoryLine[] 过滤 boundary）', () => {
  it('messagesToCommitted 跳过 boundary 行', () => {
    const lines: HistoryLine[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { compact_boundary: true, summary: '摘要', tailStartIndex: 0, preTokens: 0 },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    const items = messagesToCommitted(lines)
    // boundary 不生成 item：user(hi) + assistant-text(ok)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hi' })
    expect(items[1]).toMatchObject({ kind: 'assistant-text', text: 'ok' })
  })

  it('findUse 跳过 boundary 行反查 tool_use', () => {
    const use = (id: string): ToolUseBlock => ({ type: 'tool_use', id, name: 'bash', input: {} })
    const lines: HistoryLine[] = [
      { role: 'assistant', content: [use('t1')] },
      { compact_boundary: true, summary: 's', tailStartIndex: 0, preTokens: 0 },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ]
    expect(findUse(lines, 't1')?.name).toBe('bash')
  })
})
