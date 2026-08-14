import { describe, it, expect } from 'vitest'
import { charsToTokens, estimateContextTokens } from '../../src/services/tokenizer.js'
import type { Message } from '../../src/core/types.js'

describe('charsToTokens', () => {
  it('chars/4 向上取整', () => {
    expect(charsToTokens('')).toBe(0)
    expect(charsToTokens('hi')).toBe(1) // 2 chars → 0.5 → ceil 1
    expect(charsToTokens('hello')).toBe(2) // 5 chars → 1.25 → ceil 2
    expect(charsToTokens('abcdefgh')).toBe(2) // 8 chars → 2
  })

  it('中文按字符数算（每字 1 char，已知偏低，仅判定用）', () => {
    expect(charsToTokens('你好世界')).toBe(1) // 4 chars → 1 token
  })
})

describe('estimateContextTokens', () => {
  it('system + text block 累加', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    ]
    // system 'ab'(2) + text 'hello world'(11) = 13 → ceil(13/4) = 4
    expect(estimateContextTokens('ab', messages)).toBe(4)
  })

  it('tool_use block 计入（name + input JSON）', () => {
    const input = { path: '/a.ts' }
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input }] },
    ]
    const expectedChars = 'read_file'.length + JSON.stringify(input).length
    expect(estimateContextTokens('', messages)).toBe(Math.ceil(expectedChars / 4))
    expect(estimateContextTokens('', messages)).toBeGreaterThan(0)
  })

  it('tool_result block 计入（content）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here' }] },
    ]
    expect(estimateContextTokens('', messages)).toBe(Math.ceil('file contents here'.length / 4))
  })

  it('多消息累加', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'aaaa' }] }, // 4
      { role: 'assistant', content: [{ type: 'text', text: 'bbbb' }] }, // 4
    ]
    expect(estimateContextTokens('', messages)).toBe(2) // 8 → 2
  })

  it('空 messages → 仅 system chars/4', () => {
    expect(estimateContextTokens('abcdefgh', [])).toBe(2)
  })
})
