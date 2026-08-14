import { describe, it, expect } from 'vitest'
import { buildContextMessages } from '../../src/core/context.js'
import type { HistoryLine, Message } from '../../src/core/types.js'

function msg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function summaryText(s: string): string {
  return `[此前对话已压缩] ${s}`
}

describe('buildContextMessages（投影纯函数）', () => {
  it('无 boundary → 全量 Message', () => {
    const lines: HistoryLine[] = [msg('a'), msg('b'), msg('c')]
    expect(buildContextMessages(lines)).toEqual([msg('a'), msg('b'), msg('c')])
  })

  it('有 boundary → [summary] + tailStartIndex 之后的 Message（tail 原文 + 新消息）', () => {
    const lines: HistoryLine[] = [
      msg('old1'),
      msg('old2'), // tailStartIndex=2 之前 → 被压缩
      msg('tail1'),
      msg('tail2'), // tail 原文保留
      { compact_boundary: true, summary: '摘要', tailStartIndex: 2, preTokens: 100 },
      msg('new1'), // boundary 后新消息
    ]
    const result = buildContextMessages(lines)
    expect(result).toHaveLength(4) // summary + tail1 + tail2 + new1
    expect(result[0]).toEqual({ role: 'user', content: [{ type: 'text', text: summaryText('摘要') }] })
    expect(result[1]).toEqual(msg('tail1'))
    expect(result[2]).toEqual(msg('tail2'))
    expect(result[3]).toEqual(msg('new1'))
  })

  it('多个 boundary → 只认最后一个', () => {
    const lines: HistoryLine[] = [
      msg('old'),
      { compact_boundary: true, summary: '旧摘要', tailStartIndex: 0, preTokens: 50 },
      msg('mid'),
      { compact_boundary: true, summary: '新摘要', tailStartIndex: 1, preTokens: 80 },
      msg('recent'),
    ]
    // msgs（过滤两个 boundary）= [old, mid, recent]；最后 boundary tailStartIndex=1
    // 投影 = [新摘要] + msgs[1..] = [新摘要, mid, recent]
    const result = buildContextMessages(lines)
    expect(result[0]).toEqual({ role: 'user', content: [{ type: 'text', text: summaryText('新摘要') }] })
    expect(result[1]).toEqual(msg('mid'))
    expect(result[2]).toEqual(msg('recent'))
  })

  it('tailStartIndex 超过 msgs 长度 → 钳到末尾，只返回 summary', () => {
    const lines: HistoryLine[] = [
      msg('a'),
      { compact_boundary: true, summary: '摘要', tailStartIndex: 999, preTokens: 100 },
    ]
    const result = buildContextMessages(lines)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: [{ type: 'text', text: summaryText('摘要') }] })
  })

  it('空 lines → 空数组', () => {
    expect(buildContextMessages([])).toEqual([])
  })

  it('boundary 在最前（tailStartIndex=0）→ [summary] + 全部 Message', () => {
    const lines: HistoryLine[] = [
      { compact_boundary: true, summary: '初始摘要', tailStartIndex: 0, preTokens: 0 },
      msg('a'),
      msg('b'),
    ]
    const result = buildContextMessages(lines)
    expect(result).toHaveLength(3) // summary + a + b
    expect(result[0]).toEqual({ role: 'user', content: [{ type: 'text', text: summaryText('初始摘要') }] })
  })
})
