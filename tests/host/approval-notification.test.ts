/**
 * 批2d（§13.1 拍板-1）：Notification hook（第七事件）触发留痕测试。
 * 两条触发路径：审批挂起 N 秒未应答（broker 定时器）+ 空闲等待用户输入 N 秒（finishTurn 定时器）。
 * 生命周期契约：应答/超时取消定时器、同一挂起只触发一次、dispose 清理（不断言泄漏但保证不重复触发）。
 */

import { describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import type { HookRunner } from '../../src/services/hooks/runner.js'

class ScriptProvider implements LLMProvider {
  readonly type = 'mock'
  private call = 0
  constructor(private readonly script: Delta[][]) {}
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const mkTool = (name: string): Tool => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
})

interface Recorder {
  events: string[]
  inputs: Array<Record<string, unknown>>
}

function makeHost(
  script: Delta[][],
  hooks: Recorder,
  configPatch: Partial<Config> = {},
  tools: Tool[] = [mkTool('write-ish')],
): HostSession {
  const reg = new ToolRegistryImpl()
  for (const t of tools) reg.register(t)
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const runner = {
    hasHandlers: (event: string) => event === 'Notification',
    dispatch: async (event: string, input: Record<string, unknown>) => {
      hooks.events.push(event)
      hooks.inputs.push(input)
      return { block: false, additionalContext: [], systemMessages: [] }
    },
  } as unknown as HookRunner
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 40,
    sandbox: { defaultMode: 'default' },
    ...configPatch,
  }
  return new HostSession({
    providerRegistry: { getByType: () => new ScriptProvider(script) } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
    hookRunner: runner,
  })
}

const collect = (host: HostSession): ProtocolEvent[] => {
  const evs: ProtocolEvent[] = []
  host.subscribe((ev) => evs.push(ev))
  return evs
}

const run = async (host: HostSession): Promise<void> => {
  await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
  await host.whenIdle()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const toolRound: Delta[] = [
  { type: 'tool_use_start', id: 'w1', name: 'write-ish' },
  { type: 'tool_use_end', id: 'w1' },
  { type: 'done', stop_reason: 'tool_use' },
]
const textRound: Delta[] = [{ type: 'text', text: '回答完毕' }, { type: 'done', stop_reason: 'end' }]

describe('Notification hook：审批挂起 N 秒未应答触发一次', () => {
  it('挂起超过 N 秒 → dispatch(Notification, reason=approval-pending)；应答取消则不触发', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([toolRound], hooks, {
      notificationIdleSeconds: 0.05, // 50ms——测试用小阈值
      approvalTimeoutMs: 10_000, // 不让审批超时抢跑
    })
    const evs = collect(host)
    await run(host)
    expect(evs.some((e) => e.type === 'approval/requested')).toBe(true)
    await vi_waitFor(() => expect(hooks.events.filter((e) => e === 'Notification').length).toBe(1))
    expect(hooks.inputs[0]).toMatchObject({ event: 'Notification', reason: 'approval-pending', tool_name: 'write-ish' })
  }, 15_000)

  it('N 秒内应答 → 取消定时器，不触发 Notification', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([toolRound, textRound], hooks, {
      notificationIdleSeconds: 1, // 1s 内应答 → 不触发
      approvalTimeoutMs: 0,
    })
    const evs = collect(host)
    // run 与应答并行：turn 因审批挂起不结束，须边跑边答
    const running = run(host)
    for (let i = 0; i < 500; i++) {
      const req = evs.find((e) => e.type === 'approval/requested')
      if (req != null) {
        await host.send({ op: 'approval/respond', requestId: (req as { requestId: string }).requestId, decision: 'once' })
        break
      }
      await sleep(20)
    }
    await running
    await sleep(300) // 超过应答时刻，定时器若未取消会在此窗口触发
    expect(hooks.events).toHaveLength(0)
  }, 15_000)
})

describe('Notification hook：空闲等待用户输入 N 秒触发', () => {
  it('轮结束后空闲 N 秒 → dispatch(Notification, reason=idle)；只触发一次', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([textRound], hooks, { notificationIdleSeconds: 0.05 })
    await run(host)
    await vi_waitFor(() => expect(hooks.events.filter((e) => e === 'Notification').length).toBe(1))
    expect(hooks.inputs[0]).toMatchObject({ event: 'Notification', reason: 'idle' })
    await sleep(200)
    expect(hooks.events.filter((e) => e === 'Notification').length).toBe(1) // 不重复
  }, 15_000)

  it('新 prompt 取消 idle 定时器；无 Notification handler → 零开销跳过', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([textRound], hooks, { notificationIdleSeconds: 10 }) // 大阈值：不触发
    await run(host)
    host.dispose()
    expect(hooks.events).toHaveLength(0)
  })
})

/** 本地轮询等待（vitest 版本未导出 waitFor，手写同语义） */
async function vi_waitFor(fn: () => void): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      fn()
      return
    } catch {
      await sleep(50)
    }
  }
  fn() // 最后一次仍失败则抛断言错误
}
