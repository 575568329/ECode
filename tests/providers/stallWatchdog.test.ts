/**
 * P0-B 流停滞看门狗（方案 docs/详设/2026-09-02_后续-真机诊断修复方案 §2）。
 * 覆盖：helper 纯函数 + OpenaiProvider 四场景（vi.mock openai，短真 timer）+ anthropic 转译一场景。
 * 场景对照（审阅钉死的形态）：零产出 stall→重试 1 次→二次 retryable:false 温和终止；
 * 慢滴（内容性 delta 间隔 < 阈值）不误杀；用户中断优先。
 * 2026-09-03：有产出 stall 升级为纯文本自动续写（stallContinue.test.ts 详钉）——此处保留
 * 「续写额度耗尽仍停滞 → STREAM_STALL」的终态收敛锚。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// —— openai mock：create(body, options) 可编程流；signal abort → 迭代器静默结束（v7 SDK 形态）——
const createMock = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: createMock } } })),
}))

// —— anthropic mock：MessageStream.abort() → 迭代器抛 APIUserAbortError（该 SDK 真实形态——
//    与 openai 的静默收尾不同分支，必须分别钉）——
const messagesStreamMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { stream: messagesStreamMock } })),
}))

import { OpenaiProvider } from '../../src/providers/openai.js'
import { AnthropicProvider } from '../../src/providers/anthropic.js'
import { createStallWatchdog, DEFAULT_STREAM_STALL_MS } from '../../src/providers/stallWatchdog.js'
import type { LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'

beforeEach(() => {
  createMock.mockReset()
  messagesStreamMock.mockReset()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type OpenaiChunk = {
  choices: Array<{ index: number; delta: { content?: string }; finish_reason: string | null }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

/** 静默死流：永不产出；signal abort 后**静默结束**（openai v7 streaming.mjs 吞 AbortError 形态） */
function silentStream(signal?: AbortSignal): AsyncIterable<OpenaiChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}

/** 慢滴活流：interval<stallMs 的内容 delta 流 + 正常收尾（usage/done） */
async function* dripStream(n: number, interval: number): AsyncIterable<OpenaiChunk> {
  for (let i = 0; i < n; i++) {
    await sleep(interval)
    yield { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }
  }
  yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: n } }
}

/** 产出一段后静默死流（有产出 stall 形态） */
async function* produceThenSilent(signal: AbortSignal): AsyncIterable<OpenaiChunk> {
  yield { choices: [{ index: 0, delta: { content: '半截' }, finish_reason: null }] }
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function makeReq(stallMs: number, signal?: AbortSignal): LLMProviderRunRequest {
  return {
    name: 't', baseURL: 'http://x', apiKey: 'k', model: 'm',
    system: 's', messages: [], tools: [],
    streamStallMs: stallMs,
    ...(signal ? { signal } : {}),
  }
}

async function collect(p: OpenaiProvider, req: LLMProviderRunRequest): Promise<Delta[]> {
  const out: Delta[] = []
  for await (const d of p.run(req)) out.push(d)
  return out
}

describe('createStallWatchdog（helper 纯函数）', () => {
  it('stallMs=0 完全旁路：signal 原样透传、永不触发', async () => {
    const user = new AbortController()
    const wd = createStallWatchdog(user.signal, 0)
    expect(wd.signal).toBe(user.signal)
    await sleep(60)
    expect(wd.fired()).toBe(false)
    wd.dispose()
  })

  it('零内容超时触发：fired 置位 + 组合 signal abort', async () => {
    const wd = createStallWatchdog(undefined, 50)
    expect(wd.signal).toBeDefined()
    await sleep(90)
    expect(wd.fired()).toBe(true)
    expect(wd.signal?.aborted).toBe(true)
    wd.dispose()
  })

  it('feed 重置计时：持续喂狗不触发', async () => {
    const wd = createStallWatchdog(undefined, 60)
    for (let i = 0; i < 4; i++) {
      await sleep(30)
      wd.feed()
    }
    expect(wd.fired()).toBe(false)
    wd.dispose()
  })

  it('用户 signal 单独 abort 组合 signal（与停滞无关）', () => {
    const user = new AbortController()
    const wd = createStallWatchdog(user.signal, 10_000)
    user.abort()
    expect(wd.signal?.aborted).toBe(true)
    expect(wd.fired()).toBe(false) // 不是看门狗触发
    wd.dispose()
  })
})

describe('OpenaiProvider 看门狗（短真 timer）', () => {
  it('零产出 stall → 静默重试 1 次 → 二次仍停滞 → STREAM_STALL(retryable:false) 温和终止', async () => {
    createMock.mockImplementation(async (_body: unknown, opts: { signal?: AbortSignal }) => silentStream(opts?.signal))
    const p = new OpenaiProvider()
    const deltas = await collect(p, makeReq(80))
    expect(createMock).toHaveBeenCalledTimes(2) // 恰好重试一次
    const err = deltas.find((d) => d.type === 'error')
    expect(err).toBeDefined()
    if (err?.type !== 'error') throw new Error('unreachable')
    expect(err.error.code).toBe('STREAM_STALL')
    expect(err.error.retryable).toBe(false)
    expect(err.error.message).toContain('已自动重试 1 次')
  })

  it('慢滴活流（内容 delta 间隔 < 阈值）不误杀：正常收尾 done end + usage', async () => {
    createMock.mockImplementation(async () => dripStream(6, 20))
    const p = new OpenaiProvider()
    const deltas = await collect(p, makeReq(120))
    expect(deltas.some((d) => d.type === 'error')).toBe(false)
    expect(deltas.some((d) => d.type === 'done' && d.stop_reason === 'end')).toBe(true)
    expect(deltas.some((d) => d.type === 'usage')).toBe(true)
  })

  it('有产出 stall → 2026-09-03 升级为纯文本自动续写：两段续写（共 3 请求）后仍停滞 → STREAM_STALL 收敛', async () => {
    createMock.mockImplementation(async (_body: unknown, opts: { signal?: AbortSignal }) =>
      produceThenSilent(opts?.signal as AbortSignal))
    const p = new OpenaiProvider()
    const deltas = await collect(p, makeReq(80))
    // 1 原始 + MAX_STALL_CONTINUATIONS(2) 次续写 = 3 次请求（续写额度封顶后终止）
    expect(createMock).toHaveBeenCalledTimes(1 + 2)
    const err = deltas.find((d) => d.type === 'error')
    expect(err).toBeDefined()
    if (err?.type !== 'error') throw new Error('unreachable')
    expect(err.error.code).toBe('STREAM_STALL')
    expect(err.error.retryable).toBe(false)
    expect(err.error.message).toContain('部分产出')
    expect(err.error.message).toContain('续写')
    // 半截 text 已照常流出（消费方自行固化）
    expect(deltas.some((d) => d.type === 'text')).toBe(true)
  })

  it('用户中断优先：流期间 abort → 不报 STREAM_STALL、不重试，静默结束', async () => {
    createMock.mockImplementation(async (_body: unknown, opts: { signal?: AbortSignal }) => silentStream(opts?.signal))
    const user = new AbortController()
    const p = new OpenaiProvider()
    const collectP = collect(p, makeReq(200, user.signal)) // 看门狗 200ms，用户 60ms 先断
    setTimeout(() => user.abort(), 60)
    const deltas = await collectP
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(deltas.some((d) => d.type === 'error')).toBe(false)
  })
})

describe('AnthropicProvider 看门狗（抛出路径——abort 转 APIUserAbortError 的转译分支）', () => {
  /** 假 MessageStream：pending 至 abort()；abort 后迭代器抛 APIUserAbortError（SDK 真实形态） */
  function fakeThrowingStream(): { abort: () => void; [Symbol.asyncIterator](): AsyncGenerator<never> } {
    let release: () => void = () => {}
    const wait = new Promise<void>((r) => {
      release = r
    })
    return {
      abort: () => release(),
      async *[Symbol.asyncIterator]() {
        await wait
        const e = new Error('Request was aborted.')
        e.name = 'APIUserAbortError'
        throw e
      },
    }
  }

  it('零产出 stall → 重试 1 次 → 二次停滞抛出被转译为 STREAM_STALL（不误判用户中断）', async () => {
    messagesStreamMock.mockImplementation(() => fakeThrowingStream())
    const p = new AnthropicProvider()
    const deltas: Delta[] = []
    for await (const d of p.run(makeReq(80))) deltas.push(d)
    expect(messagesStreamMock).toHaveBeenCalledTimes(2)
    const err = deltas.find((d) => d.type === 'error')
    expect(err).toBeDefined()
    if (err?.type !== 'error') throw new Error('unreachable')
    expect(err.error.code).toBe('STREAM_STALL')
    expect(err.error.retryable).toBe(false)
  })
})

describe('默认值', () => {
  it('DEFAULT_STREAM_STALL_MS = 90s（方案 §2 拍板值）', () => {
    expect(DEFAULT_STREAM_STALL_MS).toBe(90_000)
  })
})
