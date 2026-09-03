/**
 * 停滞续写策略（stallContinue.ts，2026-09-03「写不了」根治）。
 * 覆盖：shouldContinueAfterStall 判定矩阵（续写/回退边界）+ stallContinueReq 请求变换 +
 * OpenaiProvider 集成两场景（纯文本停滞自动续写成功收敛；结构化 delta 停滞保持旧终态）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: createMock } } })),
}))

import { OpenaiProvider } from '../../src/providers/openai.js'
import {
  shouldContinueAfterStall,
  stallContinueReq,
  continuationPrompt,
  MAX_STALL_CONTINUATIONS,
} from '../../src/providers/stallContinue.js'
import type { LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, Message } from '../../src/core/types.js'

beforeEach(() => createMock.mockReset())

describe('shouldContinueAfterStall（判定矩阵）', () => {
  const base = { producedText: '半截内容', sawStructured: false, continuationsUsed: 0, userAborted: false }
  it('纯文本半截 → 续写', () => {
    expect(shouldContinueAfterStall(base)).toBe(true)
  })
  it('零产出 → false（走既有零产出静默重试路径，不归续写管）', () => {
    expect(shouldContinueAfterStall({ ...base, producedText: '' })).toBe(false)
  })
  it('出现过 thinking/tool_use → false（半截结构化固化不安全——保持旧 STREAM_STALL 终态）', () => {
    expect(shouldContinueAfterStall({ ...base, sawStructured: true })).toBe(false)
  })
  it('续写额度用尽 → false（MAX_STALL_CONTINUATIONS 封顶）', () => {
    expect(shouldContinueAfterStall({ ...base, continuationsUsed: MAX_STALL_CONTINUATIONS })).toBe(false)
    expect(shouldContinueAfterStall({ ...base, continuationsUsed: MAX_STALL_CONTINUATIONS - 1 })).toBe(true)
  })
  it('用户已中断 → false（中断优先，绝不自发请求）', () => {
    expect(shouldContinueAfterStall({ ...base, userAborted: true })).toBe(false)
  })
})

describe('stallContinueReq（请求变换）', () => {
  it('无累计文本 → 原样返回（首次请求零改动）', () => {
    const req = { messages: [{ role: 'user', content: '写文档' }] as Message[] }
    expect(stallContinueReq(req, '')).toBe(req)
  })
  it('有累计文本 → 追加 [assistant(半截), user(续写指令)]，原消息不动', () => {
    const req = { messages: [{ role: 'user', content: '写文档' }] as Message[] }
    const out = stallContinueReq(req, '半截文本')
    expect(out).not.toBe(req)
    expect(out.messages).toHaveLength(3)
    expect(out.messages[0]).toBe(req.messages[0]) // 原消息引用不变（只追加）
    expect(out.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '半截文本' }] })
    expect(out.messages[2].role).toBe('user')
    const prompt = (out.messages[2].content as Array<{ text: string }>)[0].text
    expect(prompt).toBe(continuationPrompt('半截文本'))
  })
  it('continuationPrompt 含「严禁重复」与半截尾部锚点（超 200 字只带尾 200）', () => {
    const p = continuationPrompt('x'.repeat(300) + '尾部锚点')
    expect(p).toContain('严禁重复')
    expect(p).toContain('尾部锚点')
    expect(p).not.toContain('x'.repeat(300)) // 头部不整段携带（控 token）
  })
})

// —— 集成：openai mock 流按调用次数编程——第一段产「半截」后死，第二段产「接续」后正常收尾 ——
type OpenaiChunk = { choices: Array<{ index: number; delta: { content?: string }; finish_reason: string | null }> }

function makeReq(stallMs: number): LLMProviderRunRequest {
  return { name: 't', baseURL: 'http://x', apiKey: 'k', model: 'm', system: 's', messages: [], tools: [], streamStallMs: stallMs }
}

describe('OpenaiProvider 停滞续写（集成）', () => {
  it('纯文本半截停滞 → 自动续写第二段 → 无 error、内容拼接完整、第二次请求带续写消息', async () => {
    // 死流工厂：第 n 次调用产一段文本后按 signal 静默死；最后一次正常收尾
    createMock
      .mockImplementationOnce(async (_b: unknown, opts: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ index: 0, delta: { content: '第一段半截' }, finish_reason: null }] }
          await new Promise<void>((r) => {
            opts?.signal?.addEventListener('abort', () => r(), { once: true })
          })
        },
      }))
      .mockImplementationOnce(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ index: 0, delta: { content: '第二段接续' }, finish_reason: null }] }
          yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        },
      }))
    const p = new OpenaiProvider()
    const deltas: Delta[] = []
    for await (const d of p.run(makeReq(80))) deltas.push(d)
    // 无错误 + 全文连续
    expect(deltas.some((d) => d.type === 'error')).toBe(false)
    const text = deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')
    expect(text).toBe('第一段半截第二段接续')
    // 第二次请求体带 [assistant(半截), user(续写指令)]
    expect(createMock).toHaveBeenCalledTimes(2)
    const secondBody = createMock.mock.calls[1]?.[0] as { messages: Array<{ role: string; content: unknown }> }
    expect(secondBody.messages.at(-2)?.role).toBe('assistant')
    expect(secondBody.messages.at(-1)?.role).toBe('user')
    expect(JSON.stringify(secondBody.messages.at(-1)?.content)).toContain('严禁重复')
  })

  it('含 tool_use 的半截停滞 → 保持旧终态 STREAM_STALL（不续写）', async () => {
    createMock.mockImplementation(async (_b: unknown, opts: { signal?: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ index: 0, delta: { content: '前文' }, finish_reason: null }] }
        yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ls', arguments: '{}' } }] }, finish_reason: null }] }
        await new Promise<void>((r) => {
          opts?.signal?.addEventListener('abort', () => r(), { once: true })
        })
      },
    }))
    const p = new OpenaiProvider()
    const deltas: Delta[] = []
    for await (const d of p.run(makeReq(80))) deltas.push(d)
    expect(createMock).toHaveBeenCalledTimes(1) // 不续写
    const err = deltas.find((d) => d.type === 'error')
    expect(err).toBeDefined()
    if (err?.type !== 'error') throw new Error('unreachable')
    expect(err.error.code).toBe('STREAM_STALL')
  })
})
