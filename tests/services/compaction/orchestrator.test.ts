import { describe, it, expect, vi } from 'vitest'
import {
  CompactionOrchestrator,
  findLastSummary,
  isBoundary,
  type BoundaryLine,
  type HistoryLine,
} from '../../../src/services/compaction/orchestrator.js'
import type { CompactionStrategy, CompactionResult } from '../../../src/services/compaction/strategy.js'
import type { LLMProvider } from '../../../src/providers/interface.js'

/** 可控行为的 mock 策略。 */
function mockStrategy(opts: {
  name: string
  cost?: 'free' | 'llm'
  shouldRun?: boolean
  result: CompactionResult
  ran?: () => void
}): CompactionStrategy {
  return {
    name: opts.name,
    cost: opts.cost ?? 'llm',
    shouldRun: () => opts.shouldRun ?? true,
    run: async () => {
      opts.ran?.()
      return opts.result
    },
  }
}

const fakeProvider = { type: 'mock', async *run() {} } as unknown as LLMProvider

function baseOpts(allMessages: HistoryLine[]) {
  return {
    messages: [],
    tokenCount: 100000,
    effectiveWindow: 180000,
    trigger: 'pressure' as const,
    provider: fakeProvider,
    providerReq: { name: 't', baseURL: 'x', apiKey: 'k', model: 'm' },
    allMessages,
  }
}

describe('CompactionOrchestrator', () => {
  it('策略产出 → 追加 boundary 到 allMessages（结构正确）', async () => {
    const all: HistoryLine[] = []
    const orch = new CompactionOrchestrator()
    orch.register(
      mockStrategy({ name: 's', result: { compacted: true, summary: '摘要', tailStartIndex: 5, preTokens: 999 } }),
    )
    const ok = await orch.run(baseOpts(all))
    expect(ok).toBe(true)
    expect(all).toHaveLength(1)
    expect(isBoundary(all[0]!)).toBe(true)
    const b = all[0] as BoundaryLine
    expect(b.summary).toBe('摘要')
    // P0-1: tailStartIndex 经编排器翻译（投影→全量绝对）；baseOpts messages 空 → anchor undefined → absIdx=0
    expect(b.tailStartIndex).toBe(0)
    expect(b.preTokens).toBe(999)
  })

  it('按 cost 排序：free 先于 llm', async () => {
    const order: string[] = []
    const all: HistoryLine[] = []
    const orch = new CompactionOrchestrator()
    orch.register(
      mockStrategy({
        name: 'llm-1', cost: 'llm',
        result: { compacted: true, summary: 'a', tailStartIndex: 1 },
        ran: () => order.push('llm-1'),
      }),
    )
    orch.register(
      mockStrategy({
        name: 'free-1', cost: 'free',
        result: { compacted: false },
        ran: () => order.push('free-1'),
      }),
    )
    await orch.run(baseOpts(all))
    expect(order).toEqual(['free-1', 'llm-1'])
  })

  it('shouldRun=false → 跳过该策略', async () => {
    const all: HistoryLine[] = []
    const orch = new CompactionOrchestrator()
    orch.register(mockStrategy({ name: 'skip', shouldRun: false, result: { compacted: true, summary: 'x', tailStartIndex: 1 } }))
    orch.register(mockStrategy({ name: 'run', result: { compacted: true, summary: 'y', tailStartIndex: 2 } }))
    await orch.run(baseOpts(all))
    expect((all[0] as BoundaryLine).summary).toBe('y')
  })

  it('首个策略 compacted:false → 试下一个', async () => {
    const all: HistoryLine[] = []
    const orch = new CompactionOrchestrator()
    orch.register(mockStrategy({ name: 'fail', result: { compacted: false } }))
    orch.register(mockStrategy({ name: 'ok', result: { compacted: true, summary: '成功', tailStartIndex: 3 } }))
    const ok = await orch.run(baseOpts(all))
    expect(ok).toBe(true)
    expect((all[0] as BoundaryLine).summary).toBe('成功')
  })

  it('所有策略都失败 → false，不追加 boundary', async () => {
    const all: HistoryLine[] = []
    const orch = new CompactionOrchestrator()
    orch.register(mockStrategy({ name: 'a', result: { compacted: false } }))
    orch.register(mockStrategy({ name: 'b', result: { compacted: false } }))
    expect(await orch.run(baseOpts(all))).toBe(false)
    expect(all).toHaveLength(0)
  })

  it('无策略 → false', async () => {
    const orch = new CompactionOrchestrator()
    expect(await orch.run(baseOpts([]))).toBe(false)
  })

  it('熔断：连续 3 次压缩失败 → 不再自动重试；manual 重置；成功重置', async () => {
    const orch = new CompactionOrchestrator()
    const fail = mockStrategy({ name: 'f', result: { compacted: false } })
    orch.register(fail)
    // 3 次失败（每次都真的调了策略 run）
    expect(await orch.run(baseOpts([]))).toBe(false)
    expect(await orch.run(baseOpts([]))).toBe(false)
    expect(await orch.run(baseOpts([]))).toBe(false)
    expect(orch.isTripped()).toBe(true)
    // 熔断后自动触发：直接 false，策略不再被调
    const ran = vi.fn()
    orch.register(mockStrategy({ name: 'n', result: { compacted: false }, ran }))
    expect(await orch.run(baseOpts([]))).toBe(false)
    expect(ran).not.toHaveBeenCalled()
    // manual 触发重置计数 → 策略重新可跑
    const all: HistoryLine[] = []
    orch.register(mockStrategy({ name: 'ok', result: { compacted: true, summary: '手动成功', tailStartIndex: 0 } }))
    expect(await orch.run({ ...baseOpts(all), trigger: 'manual' })).toBe(true)
    expect(orch.isTripped()).toBe(false)
    // 成功重置后，自动触发恢复正常路径
    expect(await orch.run(baseOpts(all))).toBe(true)
  })

  it('熔断不误伤：shouldRun 全挡住（策略未真正执行）→ 不进失败计数', async () => {
    const orch = new CompactionOrchestrator()
    orch.register(mockStrategy({ name: 'skip', shouldRun: false, result: { compacted: false } }))
    await orch.run(baseOpts([]))
    await orch.run(baseOpts([]))
    await orch.run(baseOpts([]))
    expect(orch.isTripped()).toBe(false) // 没真正跑，不算失败
  })

  it('滚动 summary：未传 previousSummary → 从 allMessages 找最后 boundary', async () => {
    const all: HistoryLine[] = [
      { compact_boundary: true, summary: '旧摘要', tailStartIndex: 0, preTokens: 100 },
    ]
    let captured: string | undefined
    const orch = new CompactionOrchestrator()
    orch.register({
      name: 'spy',
      cost: 'llm',
      shouldRun: () => true,
      run: async (ctx) => {
        captured = ctx.previousSummary
        return { compacted: true, summary: '新', tailStartIndex: 1 }
      },
    })
    await orch.run(baseOpts(all))
    expect(captured).toBe('旧摘要')
  })

  it('boundary 追加不删除旧消息（投影派 append-only）', async () => {
    const all: HistoryLine[] = [
      { role: 'user', content: [{ type: 'text', text: '旧消息' }] },
    ]
    const orch = new CompactionOrchestrator()
    orch.register(mockStrategy({ name: 's', result: { compacted: true, summary: '摘要', tailStartIndex: 1 } }))
    await orch.run(baseOpts(all))
    expect(all).toHaveLength(2) // 旧消息 + boundary（旧消息不删）
    expect(all[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '旧消息' }] })
    expect(isBoundary(all[1]!)).toBe(true)
  })
})

describe('findLastSummary / isBoundary', () => {
  it('findLastSummary 返回最后 boundary 的 summary', () => {
    const lines: HistoryLine[] = [
      { compact_boundary: true, summary: '旧', tailStartIndex: 0, preTokens: 1 },
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
      { compact_boundary: true, summary: '新', tailStartIndex: 0, preTokens: 2 },
    ]
    expect(findLastSummary(lines)).toBe('新')
  })

  it('无 boundary → undefined', () => {
    expect(findLastSummary([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBeUndefined()
  })

  it('isBoundary 守卫', () => {
    expect(isBoundary({ compact_boundary: true, summary: 'x', tailStartIndex: 0, preTokens: 0 })).toBe(true)
    expect(isBoundary({ role: 'user', content: [] })).toBe(false)
  })
})
