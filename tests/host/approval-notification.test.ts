/**
 * 批2d（§13.1 拍板-1）：Notification hook（第七事件）触发留痕测试。
 * 两条触发路径：审批挂起 N 秒未应答（broker 定时器）+ 空闲等待用户输入 N 秒（finishTurn 定时器）。
 * 生命周期契约：应答/超时取消定时器、同一挂起只触发一次、dispose 清理（不断言泄漏但保证不重复触发）。
 *
 * 批2d-fix（四角色审阅后收口）：
 * - 收敛方式全部显式应答（不走 approvalTimeout 抢跑）；取消类断言按 reason 过滤且观察窗 > 阈值；
 * - 新增：mcp-permission 不挂通知表（防自续环）/notificationIdleSeconds=0 双路径零触发/always 级联清
 *   他人 notifyTimer/timeout 先收敛不通知/AJV enum 接受 Notification 真链路。
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
import { ApprovalBroker } from '../../src/host/approval.js'
import { InMemoryChannel } from '../../src/protocol/channel.js'
import { parseHookSpecs } from '../../src/services/hooks/validate.js'

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

/** 等到首个 approval/requested 出现并显式应答 once（收敛不走超时抢跑） */
async function respondFirstApproval(host: HostSession, evs: ProtocolEvent[], decision: 'once' | 'always' = 'once'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const req = evs.find((e) => e.type === 'approval/requested')
    if (req != null) {
      await host.send({ op: 'approval/respond', requestId: (req as { requestId: string }).requestId, decision })
      return
    }
    await sleep(20)
  }
  throw new Error('approval/requested 未出现')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const notified = (hooks: Recorder, reason: string): number =>
  hooks.inputs.filter((x) => x.event === 'Notification' && x.reason === reason).length

const toolRound: Delta[] = [
  { type: 'tool_use_start', id: 'w1', name: 'write-ish' },
  { type: 'tool_use_end', id: 'w1' },
  { type: 'done', stop_reason: 'tool_use' },
]
const textRound: Delta[] = [{ type: 'text', text: '回答完毕' }, { type: 'done', stop_reason: 'end' }]

describe('Notification hook：审批挂起 N 秒未应答触发一次', () => {
  it('挂起超过 N 秒 → dispatch(Notification, reason=approval-pending)（批2d-fix：显式应答收敛+按 reason 断言）', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([toolRound, textRound], hooks, {
      notificationIdleSeconds: 0.05, // 50ms——测试用小阈值
      approvalTimeoutMs: 0, // 不让审批超时抢跑（收敛靠显式应答）
    })
    const evs = collect(host)
    const running = run(host)
    await vi_waitFor(() => expect(notified(hooks, 'approval-pending')).toBe(1))
    expect(hooks.inputs[0]).toMatchObject({ event: 'Notification', reason: 'approval-pending', tool_name: 'write-ish' })
    await respondFirstApproval(host, evs) // 显式收敛（同一挂起已通知过，不再触发）
    await running
    expect(notified(hooks, 'approval-pending')).toBe(1) // 只触发一次
  }, 15_000)

  it('N 秒内应答 → 取消定时器；观察窗超过阈值仍无 approval-pending（批2d-fix：漏 clearTimeout 亦可检出）', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([toolRound, textRound], hooks, {
      // 审阅 P2：0.1 曾使「应答在阈值内完成」在 CI 慢机压线（观察窗仅 5×）——放宽 0.5s
      notificationIdleSeconds: 0.5,
      approvalTimeoutMs: 0,
    })
    const evs = collect(host)
    const running = run(host) // turn 因审批挂起不结束，须边跑边答
    await respondFirstApproval(host, evs) // 应答在阈值内完成（mock 轮次毫秒级）
    await running
    await sleep(3000) // 观察窗 6× 阈值——定时器若未取消必在此触发
    expect(notified(hooks, 'approval-pending')).toBe(0)
  }, 15_000)
})

describe('Notification hook：空闲等待用户输入 N 秒触发', () => {
  it('轮结束后空闲 N 秒 → dispatch(Notification, reason=idle)；只触发一次', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([textRound], hooks, { notificationIdleSeconds: 0.05 })
    await run(host)
    await vi_waitFor(() => expect(notified(hooks, 'idle')).toBe(1))
    expect(hooks.inputs[0]).toMatchObject({ event: 'Notification', reason: 'idle' })
    await sleep(200)
    expect(notified(hooks, 'idle')).toBe(1) // 不重复
  }, 15_000)

  it('新 prompt 在阈值内到达 → 首表作废不触发；新轮完成后重新起表触发（批2d-fix：真发新 prompt 验证）', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([textRound, textRound], hooks, { notificationIdleSeconds: 0.4 })
    await run(host) // 第一轮完成，idle 表起
    await sleep(100) // < 400ms：处于空闲但未到阈值
    expect(notified(hooks, 'idle')).toBe(0)
    await host.send({ op: 'prompt', text: '再来', mode: 'StartOrSteer' }) // 新轮=不再空闲，首表作废
    await host.whenIdle() // 第二轮完成（重新起表）
    await vi_waitFor(() => expect(notified(hooks, 'idle')).toBe(1)) // 新轮轮末重新起表后触发且仅一次
    await sleep(600)
    expect(notified(hooks, 'idle')).toBe(1) // 全程恰好一次——首表未越界触发
  }, 15_000)

  it('dispose 清理：轮末起表后销毁会话，阈值过后零触发（批2d-fix：补时间窗验证）', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([textRound], hooks, { notificationIdleSeconds: 0.1 })
    await run(host)
    await sleep(30) // 表已起（<100ms 阈值内 dispose）
    host.dispose()
    await sleep(400) // 超过阈值——定时器若未清理必触发
    expect(hooks.events).toHaveLength(0)
  }, 15_000)
})

describe('Notification hook：批2d-fix 补覆盖（审阅测试面收口）', () => {
  it('notificationIdleSeconds=0：审批挂起路径零触发（通知表不起）', async () => {
    const hooks: Recorder = { events: [], inputs: [] }
    const host = makeHost([toolRound], hooks, {
      notificationIdleSeconds: 0, // 0=关
      approvalTimeoutMs: 0,
    })
    const evs = collect(host)
    const running = run(host)
    await respondFirstApproval(host, evs) // 挂起毫秒级，远小于原默认阈值
    await running
    await sleep(300)
    expect(hooks.events).toHaveLength(0) // 审批挂起路径 + 轮末 idle 路径均零触发
  }, 15_000)

  it('mcp-permission 挂起不挂通知表；tool-confirm 挂起照常触发（审阅 P1-1 自续环防回归）', async () => {
    const ch = new InMemoryChannel()
    const evs: ProtocolEvent[] = []
    ch.subscribe((e) => evs.push(e))
    const notifiedKinds: string[] = []
    const broker = new ApprovalBroker(
      ch, 'ask', 0, null,
      (info) => notifiedKinds.push(info.kind),
      80, // 80ms 通知阈值（双挂起共用）
    )
    // 双挂起：扩展 hook 权限卡（自续环源头）+ MCP 工具卡
    const perm = broker.permission('ext-owner', 'Notification')
    const tool = broker.confirm({ type: 'tool_use', id: 'u1', name: 'mcp__a__t', input: {} }, 'p')
    await sleep(250) // 超过阈值 3 倍
    expect(notifiedKinds).toEqual(['tool-confirm']) // 权限卡零通知；工具卡恰好一次
    // 显式收敛两张卡
    const reqs = evs.filter((e) => e.type === 'approval/requested').map((e) => (e as { requestId: string }).requestId)
    for (const id of reqs) broker.respondApproval(id, 'once')
    expect(await perm).toBe(true) // respond 'once' → resolve(true)（permission 的 adapt 直转）
    expect(await tool).toBe(true)
    await sleep(150)
    expect(notifiedKinds).toEqual(['tool-confirm']) // 收敛后不再触发
  }, 15_000)

  it('always 级联：清同前缀他人 notifyTimer——双挂起场景零通知', async () => {
    const ch = new InMemoryChannel()
    const evs: ProtocolEvent[] = []
    ch.subscribe((e) => evs.push(e))
    const notifiedKinds: string[] = []
    const broker = new ApprovalBroker(
      ch, 'ask', 0, null,
      (info) => notifiedKinds.push(info.kind),
      200, // 200ms 阈值：应答后观察窗须超过它
    )
    const p1 = broker.confirm({ type: 'tool_use', id: 'u1', name: 'mcp__a__t1', input: {} }, 'p')
    const p2 = broker.confirm({ type: 'tool_use', id: 'u2', name: 'mcp__a__t2', input: {} }, 'p')
    const req1 = (evs.find((e) => e.type === 'approval/requested') as { requestId: string }).requestId
    broker.respondApproval(req1, 'always') // 级联放行 p2——其 notifyTimer 应被清
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    await sleep(500) // 超过阈值 2.5 倍——级联若漏清必触发
    expect(notifiedKinds).toHaveLength(0)
  }, 15_000)

  it('timeout 先收敛则通知不发：小超时 + 大通知阈值反向构造', async () => {
    const ch = new InMemoryChannel()
    ch.subscribe(() => {})
    const notifiedKinds: string[] = []
    const broker = new ApprovalBroker(
      ch, 'ask', 100, null, // 超时 100ms
      (info) => notifiedKinds.push(info.kind),
      500, // 通知阈值 500ms > 超时——超时必先收敛
    )
    const p = broker.confirm({ type: 'tool_use', id: 'u1', name: 'write_file', input: {} }, 'p')
    expect(await p).toBe(false) // 超时自动拒绝收敛
    await sleep(700) // 通知阈值已过——若 notifyTimer 漏清必触发
    expect(notifiedKinds).toHaveLength(0)
  }, 15_000)

  it('AJV enum 真链路：parseHookSpecs 接受 event=Notification 的 command hook', () => {
    const { hooks, warnings } = parseHookSpecs([
      { event: 'Notification', handler: { kind: 'command', command: 'echo notify' } },
      { event: 'NoSuchEvent', handler: { kind: 'command', command: 'echo x' } }, // 反例：非枚举事件被拒
    ])
    expect(hooks).toHaveLength(1)
    expect(hooks[0]).toMatchObject({ event: 'Notification', handler: { kind: 'command', command: 'echo notify' } })
    expect(warnings).toHaveLength(1) // 反对照：enum 未放开到任意字符串
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
