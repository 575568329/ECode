/** 活动流 B3：timelineReducer 归约单测（分段/封口/回填/兜底/恒等性——本方案测试重心）。 */
import { describe, it, expect } from 'vitest'
import { timelineReducer, makeTimelineIdFactory, type TimelineEntry, type TimelineReducerDeps } from '../../src/protocol/timeline.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'

let seq = 0
const deps: TimelineReducerDeps = {
  now: () => 1000,
  nextId: (kind) => `${kind}-${++seq}`,
}
const freshDeps = (): TimelineReducerDeps => ({ now: () => 1000, nextId: makeTimelineIdFactory().nextId })

const apply = (state: TimelineEntry[], evs: ProtocolEvent[], d: TimelineReducerDeps = deps): TimelineEntry[] =>
  evs.reduce((s, ev) => timelineReducer(s, ev, d), state)

describe('timelineReducer：text 分段（§3.2 核心机理）', () => {
  it('text→tool→text 不黏连：三段独立（治轮末重建跳变根）', () => {
    seq = 0
    const out = apply([], [
      { type: 'delta', seq: 1, turnId: 't', text: '前段' },
      { type: 'item/started', seq: 2, turnId: 't', itemId: 'tu_1', name: 'bash' },
      { type: 'item/completed', seq: 3, itemId: 'tu_1', name: 'bash', isError: false, summary: '', content: 'ok' },
      { type: 'delta', seq: 4, turnId: 't', text: '后段' },
    ])
    expect(out.map((e) => e.kind)).toEqual(['text', 'tool', 'text'])
    expect(out[0]).toMatchObject({ text: '前段', live: false })
    expect(out[2]).toMatchObject({ text: '后段', live: true })
  })

  it('连续 delta 追加同一 live 段', () => {
    seq = 100
    const out = apply([], [
      { type: 'delta', seq: 1, turnId: 't', text: '你' },
      { type: 'delta', seq: 2, turnId: 't', text: '好' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'text', text: '你好', live: true })
  })
})

describe('timelineReducer：thinking 按 blockIndex 配对（§3.2/TUI 审阅 P1-2）', () => {
  it('累积→ended 补 durMs；两个 thinking 块交错不错挂', () => {
    seq = 200
    const out = apply([], [
      { type: 'thinking', seq: 1, turnId: 't', blockIndex: 0, text: '想A' },
      { type: 'thinking', seq: 2, turnId: 't', blockIndex: 1, text: '想B' },
      { type: 'thinking', seq: 3, turnId: 't', blockIndex: 0, text: '继续A' },
      { type: 'thinking/ended', seq: 4, turnId: 't', blockIndex: 1, durMs: 500 },
      { type: 'thinking/ended', seq: 5, turnId: 't', blockIndex: 0, durMs: 900 },
    ])
    const th0 = out.find((e) => e.kind === 'thinking' && e.blockIndex === 0)
    const th1 = out.find((e) => e.kind === 'thinking' && e.blockIndex === 1)
    expect(th0).toMatchObject({ text: '想A继续A', durMs: 900 })
    expect(th1).toMatchObject({ text: '想B', durMs: 500 })
  })

  it('ended 无匹配块：幂等返回原状态（不炸不吞）', () => {
    const s: TimelineEntry[] = []
    const out = timelineReducer(s, { type: 'thinking/ended', seq: 1, turnId: 't', blockIndex: 7, durMs: 1 }, freshDeps())
    expect(out).toBe(s)
  })
})

describe('timelineReducer：工具条目回填（itemId 同源闭环）', () => {
  it('started→executing(digest)→completed 按 id 原位回填，同名并行不错位', () => {
    seq = 300
    const out = apply([], [
      { type: 'item/started', seq: 1, turnId: 't', itemId: 'a', name: 'bash' },
      { type: 'item/started', seq: 2, turnId: 't', itemId: 'b', name: 'bash' },
      { type: 'item/executing', seq: 3, turnId: 't', itemId: 'b', digest: 'npm test' },
      { type: 'item/completed', seq: 4, itemId: 'b', name: 'bash', isError: false, summary: '', content: 'B结果' },
      { type: 'item/completed', seq: 5, itemId: 'a', name: 'bash', isError: true, summary: '', content: 'A失败' },
    ])
    const tools = out.filter((e): e is Extract<TimelineEntry, { kind: 'tool' }> => e.kind === 'tool')
    expect(tools.map((e) => e.tool.id)).toEqual(['a', 'b'])
    const a = tools.find((e) => e.tool.id === 'a')!
    const b = tools.find((e) => e.tool.id === 'b')!
    expect(a.tool.status).toBe('error')
    expect(a.tool.content).toBe('A失败')
    expect(b.tool.status).toBe('done')
    expect(b.tool.content).toBe('B结果')
    expect(b.tool.digest).toBe('npm test') // 终态回填不丢 digest
  })

  it('completed 无 started 匹配（旧宿主）：append 终态兜底', () => {
    seq = 400
    const out = apply([], [
      { type: 'item/completed', seq: 1, itemId: 'x', name: 'read_file', isError: false, summary: '', content: '内容' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'tool' })
  })
})

describe('timelineReducer：轮边界与恒等性（渲染审阅 P1-2 memo 前提）', () => {
  it('turn/completed 封口全部 live 段', () => {
    seq = 500
    const mid = apply([], [
      { type: 'delta', seq: 1, turnId: 't', text: '流式中' },
      { type: 'thinking', seq: 2, turnId: 't', blockIndex: 0, text: '思考中' },
    ])
    const out = timelineReducer(mid, { type: 'turn/completed', seq: 3, turnId: 't' }, freshDeps())
    expect(out[0]).toMatchObject({ live: false })
    // 未闭合 thinking 保持无 endedAt（中断轮：thinking 无终态——与动态区无痕一致）
    expect((out[1] as { endedAt?: number }).endedAt).toBeUndefined()
  })

  it('无关帧到达：未动条目引用恒等（条目级 memo 生效前提）', () => {
    seq = 600
    const mid = apply([], [
      { type: 'delta', seq: 1, turnId: 't', text: '段1' },
      { type: 'item/started', seq: 2, turnId: 't', itemId: 'a', name: 'bash' },
      { type: 'delta', seq: 3, turnId: 't', text: '段2' },
    ])
    const out = timelineReducer(mid, { type: 'delta', seq: 4, turnId: 't', text: '继续' }, freshDeps())
    expect(out[0]).toBe(mid[0]) // 未动条目同一引用
    expect(out[1]).toBe(mid[1])
    expect(out[2]).not.toBe(mid[2]) // 命中条目换新
    expect(out[2]).toMatchObject({ text: '段2继续' })
  })
})
