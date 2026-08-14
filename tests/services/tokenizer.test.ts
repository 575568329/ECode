import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateContextTokens } from '../../src/services/tokenizer.js'
import type { Message } from '../../src/core/types.js'

describe('estimateTokens（UTF-8 字节/4）', () => {
  it('ASCII：bytes === chars，向上取整（与旧版 chars/4 一致）', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('hi')).toBe(1) // 2 bytes → 0.5 → ceil 1
    expect(estimateTokens('hello')).toBe(2) // 5 bytes → 1.25 → ceil 2
    expect(estimateTokens('abcdefgh')).toBe(2) // 8 bytes → 2
  })

  it('★中文按 UTF-8 字节计（3 bytes/字 ≈ 0.75 token/字，修复 chars/4 低估约 3-4 倍）', () => {
    expect(estimateTokens('你好世界')).toBe(3) // 4 字 × 3 bytes = 12 bytes → 3（旧 chars/4 只估 1）
    // 防退化回 chars/4：纯中文必须显著大于 chars/4 口径（1000 字 → 3000 bytes → 750）
    expect(estimateTokens('中'.repeat(1000))).toBe(750)
  })

  it('混合文本（ASCII + 中文按字节累加）', () => {
    expect(estimateTokens('ab你好')).toBe(2) // 2 + 6 = 8 bytes → 2
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
    const expectedBytes = 'read_file'.length + JSON.stringify(input).length
    expect(estimateContextTokens('', messages)).toBe(Math.ceil(expectedBytes / 4))
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
      { role: 'user', content: [{ type: 'text', text: 'aaaa' }] }, // 4 bytes
      { role: 'assistant', content: [{ type: 'text', text: 'bbbb' }] }, // 4 bytes
    ]
    expect(estimateContextTokens('', messages)).toBe(2) // 8 → 2
  })

  it('空 messages → 仅 system', () => {
    expect(estimateContextTokens('abcdefgh', [])).toBe(2)
  })

  it('中文 text block 按字节计（不低估）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '你好世界' }] }, // 12 bytes → 3
    ]
    expect(estimateContextTokens('', messages)).toBe(3)
  })
})
