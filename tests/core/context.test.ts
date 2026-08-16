import { describe, it, expect } from 'vitest'
import { buildContextMessages } from '../../src/core/context.js'
import type { HistoryLine, Message } from '../../src/core/types.js'

function msg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function toolMsg(id: string): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'edit_file', input: {} }] }
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
    expect(result[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: summaryText('摘要') }] })
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
    expect(result[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: summaryText('新摘要') }] })
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
    expect(result[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: summaryText('初始摘要') }] })
  })
})

// —— M9-P2：rewind 投影截断（/rewind 追加 RewindLine；截到锚消息之前=当次改动不进上下文） ——

describe('buildContextMessages：rewind 截断（M9-P2）', () => {
  it('rewind 锚定 toolUseId → 投影截到锚消息之前（锚及之后丢弃，rewind 行不出现）', () => {
    const lines: HistoryLine[] = [
      msg('a'),
      toolMsg('t1'),
      msg('b1'),
      toolMsg('t2'),
      msg('b2'),
      { rewind: true, seq: 3, toolUseId: 't2', time: '2026-08-16T00:00:00Z' },
    ]
    const result = buildContextMessages(lines)
    expect(result).toEqual([msg('a'), toolMsg('t1'), msg('b1')])
  })

  it('锚失联（toolUseId 不在消息中）→ 忽略截断（全量 Message，防御）', () => {
    const lines: HistoryLine[] = [msg('a'), msg('b'), { rewind: true, seq: 1, toolUseId: 'gone', time: 't' }]
    expect(buildContextMessages(lines)).toEqual([msg('a'), msg('b')])
  })

  it('rewind 无 toolUseId（旧点缺 meta）→ 忽略截断', () => {
    const lines: HistoryLine[] = [msg('a'), { rewind: true, seq: 1, time: 't' }, msg('b')]
    expect(buildContextMessages(lines)).toEqual([msg('a'), msg('b')])
  })

  it('多个 rewind → 最后一个生效', () => {
    const lines: HistoryLine[] = [
      msg('a'),
      toolMsg('t1'),
      msg('mid'),
      toolMsg('t2'),
      { rewind: true, seq: 5, toolUseId: 't2', time: 't2' }, // 回到 t2 前
      msg('later'),
      { rewind: true, seq: 8, toolUseId: 't1', time: 't8' }, // 再回到 t1 前（更早）
    ]
    expect(buildContextMessages(lines)).toEqual([msg('a')])
  })

  it('boundary 在 rewind 行之后（先回退再压缩）→ 拼接子集上 boundary 照常生效，rewind 后新对话保留', () => {
    const lines: HistoryLine[] = [
      msg('a'),
      toolMsg('t1'),
      msg('tail1'),
      { rewind: true, seq: 2, toolUseId: 't1', time: 't' }, // 回到 t1 前：跳过 [t1..rewind] → 保留 [a] + 后续
      { compact_boundary: true, summary: '摘要', tailStartIndex: 1, preTokens: 10 }, // 回退后压缩：msgs=[a,new1]，tailStart=1
      msg('new1'),
    ]
    const result = buildContextMessages(lines)
    // 拼接子集 msgs=[a, new1]；boundary tailStartIndex=1 → 投影=[summary, new1]
    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: summaryText('摘要') }] },
      msg('new1'),
    ])
  })

  it('boundary 在锚之前（锚前对话已压缩）→ 区间外 boundary 保留并生效', () => {
    const lines: HistoryLine[] = [
      msg('old1'),
      { compact_boundary: true, summary: '旧摘要', tailStartIndex: 0, preTokens: 10 },
      msg('a'),
      toolMsg('t1'),
      msg('post'),
      { rewind: true, seq: 2, toolUseId: 't1', time: 't' }, // 只撤销 [t1..rewind]；boundary 在区间外
    ]
    // 拼接子集=[old1, boundary, a]；msgs=[old1, a]；tailStart=0 → 投影=[summary, old1, a]
    expect(buildContextMessages(lines)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: summaryText('旧摘要') }] },
      msg('old1'),
      msg('a'),
    ])
  })
})
