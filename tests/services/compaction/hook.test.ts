/**
 * makeOnBeforeRequest 端到端集成测（M5 §10）。
 * 串联 orchestrator + SummarizeStrategy + contextWindow + buildContextMessages，
 * 验证 onBeforeRequest hook 的完整压缩链路（超阈/overflow/未触发）。
 */
import { describe, it, expect, vi } from 'vitest'
import { makeOnBeforeRequest } from '../../../src/services/compaction/hook.js'
import { buildContextMessages } from '../../../src/core/context.js'
import { CompactionOrchestrator } from '../../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../../src/services/compaction/summarize.js'
import type { LLMProvider, ProviderReq } from '../../../src/providers/interface.js'
import type { Delta, HistoryLine, Message } from '../../../src/core/types.js'

/** mock 摘要 provider：吐结构化摘要（summarize 提取 <summary>）。 */
function mockSummaryProvider(text: string): LLMProvider {
  return {
    type: 'mock',
    async *run(): AsyncIterable<Delta> {
      yield { type: 'text', text }
      yield { type: 'done', stop_reason: 'end' }
    },
  }
}

/** N 条大 text 消息（每条 4000 chars = 1000 token）。 */
function bigTextMessages(n: number): Message[] {
  const text = 'a'.repeat(4000)
  return Array.from({ length: n }, (_, i): Message => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text }],
  }))
}

function isBoundary(l: HistoryLine): boolean {
  return typeof l === 'object' && l !== null && (l as { compact_boundary?: true }).compact_boundary === true
}

describe('makeOnBeforeRequest（端到端集成）', () => {
  /** 构造 hook：用 configOverride 短路 resolveContextWindow（避免测试联网）。 */
  function setup(contextWindow: number) {
    const provider = mockSummaryProvider('<summary>## 目标\n- 完成 M5</summary>')
    const orchestrator = new CompactionOrchestrator()
    orchestrator.register(new SummarizeStrategy())
    const onCompacted = vi.fn()
    const providerReq: ProviderReq = { name: 't', baseURL: 'x', apiKey: 'k', model: 'glm-4.6', contextWindow }
    const hook = makeOnBeforeRequest(orchestrator, provider, providerReq, 'sys', { onCompacted })
    return { hook, onCompacted }
  }

  it('超阈（pressure）→ 编排器跑 summarize → boundary 追加 + onCompacted + 投影子集', async () => {
    // threshold = 10000×0.9 - 20000 = -11000 < 0 → estimated(20000) 必超 → 触发
    const { hook, onCompacted } = setup(10000)
    const messages: HistoryLine[] = bigTextMessages(20)
    const ctx = await hook(messages)
    expect(onCompacted).toHaveBeenCalledTimes(1)
    expect(isBoundary(messages.at(-1)!)).toBe(true) // boundary 追加到 messages
    // 投影子集首条是 summary 消息（[此前对话已压缩] + 摘要）
    // P1-3: summaryMsg role 看 tail[0]（避开连续同 role），不固定 user
    expect((ctx[0].content[0] as { text: string }).text).toContain('完成 M5')
  })

  it('未超阈（pressure）→ 不压缩，返回全量 Message', async () => {
    const { hook, onCompacted } = setup(1_000_000) // 大窗口
    const messages: HistoryLine[] = bigTextMessages(5) // 5000 token，远小于阈值
    const ctx = await hook(messages)
    expect(onCompacted).not.toHaveBeenCalled()
    expect(messages.every((m) => !isBoundary(m))).toBe(true)
    expect(ctx).toHaveLength(5) // 全量返回（无 boundary 投影 = 全量）
  })

  it('overflow 强制压缩（不管阈值，模拟 400 兜底/手动 /compact）', async () => {
    const { hook, onCompacted } = setup(1_000_000) // 大窗口，pressure 本不触发
    const messages: HistoryLine[] = bigTextMessages(20)
    const ctx = await hook(messages, 'overflow')
    expect(onCompacted).toHaveBeenCalledTimes(1) // overflow 强制压缩
    expect(isBoundary(messages.at(-1)!)).toBe(true)
    expect((ctx[0].content[0] as { text: string }).text).toContain('完成 M5')
  })

  it('摘要失败（provider 抛）→ 不压缩，返回原投影（降级）', async () => {
    const failProvider: LLMProvider = {
      type: 'fail',
      async *run(): AsyncIterable<Delta> {
        throw new Error('摘要 LLM 挂了')
      },
    }
    const orchestrator = new CompactionOrchestrator()
    orchestrator.register(new SummarizeStrategy())
    const onCompacted = vi.fn()
    const providerReq: ProviderReq = { name: 't', baseURL: 'x', apiKey: 'k', model: 'glm-4.6', contextWindow: 10000 }
    const hook = makeOnBeforeRequest(orchestrator, failProvider, providerReq, 'sys', { onCompacted })
    const messages: HistoryLine[] = bigTextMessages(20)
    const ctx = await hook(messages, 'overflow')
    expect(onCompacted).not.toHaveBeenCalled() // 摘要失败 → 不追加 boundary
    expect(messages.every((m) => !isBoundary(m))).toBe(true) // messages 不变
    expect(ctx).toHaveLength(20) // 返回原全量投影（降级）
  })

  it('连续两次压缩 → 第二次投影不暴涨（P0-1 回归：索引翻译防泄漏累加）', async () => {
    const { hook } = setup(10000)
    const messages: HistoryLine[] = bigTextMessages(40) // 40000 token
    await hook(messages, 'overflow') // 第一次压缩
    const ctx1Len = buildContextMessages(messages).length
    const boundaryCount1 = messages.filter(isBoundary).length
    await hook(messages, 'overflow') // 第二次压缩（关键：索引翻译在此前会错位）
    const ctx2Len = buildContextMessages(messages).length
    const boundaryCount2 = messages.filter(isBoundary).length
    expect(boundaryCount2).toBe(boundaryCount1 + 1) // 多追加一个 boundary
    // P0-1 修复前：第二次投影暴涨（索引错位 → 已摘要的旧消息泄漏回投影，越压越多）；
    //   修复后第二次投影 ≤ 第一次（tailStartIndex 翻译成全量绝对索引）
    expect(ctx2Len).toBeLessThanOrEqual(ctx1Len)
  })
})
