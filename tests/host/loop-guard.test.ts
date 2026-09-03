/**
 * M13-B2 loopGuard 测试（方案 §10 分项测试点）：
 * 复读（工具轮 feedback×2 → 第 3 次 abort；纯文本轮 onWarn）；同参工具连 8 提醒后 abort；
 * 空错连 5 提醒连 8 abort；指纹/签名变化清零；审批超时自动 reject（resolved outcome='timeout'）。
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

/** 可编程 Mock：script 每项是一轮的 delta 序列（轮数即 provider 被调次数——feedback 注入会续轮） */
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

const mkTool = (name: string, fail: boolean, ro: boolean): Tool => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: ro,
  async execute() {
    return fail ? { content: 'boom', is_error: true } : { content: 'ok' }
  },
})

/** 带 confirm 放行的宿主（readonly:false 工具走 hostConfirm——full-access 免确认免挂起） */
function makeHost(script: Delta[][], tools: Tool[] = [], configPatch: Partial<Config> = {}): HostSession {
  const reg = new ToolRegistryImpl()
  for (const t of tools) reg.register(t)
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 40,
    sandbox: { ...emptyShellConfig().sandbox, defaultMode: 'full-access' },
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

describe('M13-B2 loopGuard 三检测器', () => {
  it('跨轮复读（工具轮）：feedback ×2 后第 3 次 abort（systemMsg 说明原因）', async () => {
    const dupRound = (n: number): Delta[] => [
      { type: 'text', text: '完全相同的复读输出内容' },
      { type: 'tool_use_start', id: `t${n}`, name: 'echo' },
      { type: 'tool_use_end', id: `t${n}` },
      { type: 'done', stop_reason: 'tool_use' },
    ]
    const host = makeHost([1, 2, 3, 4, 5, 6].map(dupRound), [mkTool('echo', false, true)])
    const evs = collect(host)
    await run(host)
    const msgs = evs.filter((e) => e.type === 'systemMsg')
    expect(msgs.some((m) => m.type === 'systemMsg' && m.text.includes('loop-guard'))).toBe(true)
    // 提醒 feedback 进了 transcript（[loop-guard] 前缀 user 消息 ≥1）
    const fbLines = host.transcript.filter((l) => 'content' in l && Array.isArray(l.content) && l.content.some((b) => b.type === 'text' && b.text.includes('[loop-guard]')))
    expect(fbLines.length).toBeGreaterThanOrEqual(1)
    expect(evs.some((e) => e.type === 'turn/completed')).toBe(true) // 轮终止后正常收尾
  })

  it('同参工具：连 8 轮提醒、仍不变 abort', async () => {
    const round = (n: number): Delta[] => [
      { type: 'tool_use_start', id: `s${n}`, name: 'same' },
      { type: 'tool_use_end', id: `s${n}` },
      { type: 'done', stop_reason: 'tool_use' },
    ]
    const host = makeHost(Array.from({ length: 12 }, (_, i) => round(i)), [mkTool('same', false, true)])
    const evs = collect(host)
    await run(host)
    expect(evs.some((e) => e.type === 'systemMsg' && e.text.includes('同一工具且提醒无效'))).toBe(true)
  })

  // M13-P1 结果感知（方案验收 2·核心）：同参**异果**不累计——观测轮询（task_output 有增量）不再被误杀
  it('同参异果：连续多轮同参但结果有变化 → 不触发同参检测', async () => {
    const N = HostSession.GUARD.SIG_NUDGE + 4 // P2-3：轮数按阈值派生，不硬编码字面量
    const round = (n: number): Delta[] => [
      { type: 'text', text: `第 ${n} 轮` },
      { type: 'tool_use_start', id: `o${n}`, name: 'poll' },
      { type: 'tool_use_end', id: `o${n}` },
      { type: 'done', stop_reason: 'tool_use' },
    ]
    // 单工具按调用序号递增输出：同参（每轮输入同）但 resultHead 逐轮不同 → 签名逐轮变 → 清零
    let call = 0
    const pollTool: Tool = {
      name: 'poll',
      description: 'poll',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        return { content: `增量输出 #${call++}` }
      },
    }
    const host = makeHost(Array.from({ length: N }, (_, i) => round(i)), [pollTool])
    const evs = collect(host)
    await run(host)
    const guardMsgs = evs.filter((e) => (e.type === 'systemMsg' || e.type === 'warn') && e.text.includes('loop-guard'))
    expect(guardMsgs, `同参异果连续 ${N} 轮不应触发 loop-guard（结果变=新信息=清零）`).toEqual([])
  })

  // 验收 1（回归锚）：同参同果（零产出等待形态）仍触发——P1 后签名含 resultHead，等待保护不丢
  it('同参同果：连续 SIG_NUDGE+4 轮（零产出等待）→ nudge 后 abort', async () => {
    const N = HostSession.GUARD.SIG_NUDGE + 4
    const round = (n: number): Delta[] => [
      { type: 'text', text: `第 ${n} 轮` },
      { type: 'tool_use_start', id: `z${n}`, name: 'wait' },
      { type: 'tool_use_end', id: `z${n}` },
      { type: 'done', stop_reason: 'tool_use' },
    ]
    const host = makeHost(Array.from({ length: N }, (_, i) => round(i)), [
      {
        name: 'wait',
        description: 'wait',
        input_schema: { type: 'object', properties: {}, required: [] },
        readonly: true,
        async execute() {
          return { content: '（暂无新输出）' } // 每轮恒同——真零产出等待
        },
      },
    ])
    const evs = collect(host)
    await run(host)
    expect(evs.some((e) => e.type === 'systemMsg' && e.text.includes('同一工具且提醒无效'))).toBe(true)
  })

  it('连续空错：连 5 提醒、连 8 abort', async () => {
    const round = (n: number): Delta[] => [
      { type: 'tool_use_start', id: `e${n}`, name: 'bad' },
      { type: 'tool_use_end', id: `e${n}` },
      { type: 'done', stop_reason: 'tool_use' },
    ]
    const host = makeHost(Array.from({ length: 12 }, (_, i) => round(i)), [mkTool('bad', true, true)])
    const evs = collect(host)
    await run(host)
    expect(evs.some((e) => e.type === 'systemMsg' && e.text.includes('全部失败'))).toBe(true)
    const fb = host.transcript.filter((l) => 'content' in l && Array.isArray(l.content) && l.content.some((b) => b.type === 'text' && b.text.includes('连续') && b.text.includes('失败')))
    expect(fb.length).toBeGreaterThanOrEqual(1) // 5 轮档的提醒已注入
  })

  it('纯文本轮复读：onWarn 用户可见（warn 帧）', async () => {
    const text = [{ type: 'text', text: '一模一样的纯文本回答' }, { type: 'done', stop_reason: 'end' }] as Delta[]
    const host = makeHost([text, text, text])
    const evs = collect(host)
    for (let i = 0; i < 3; i++) await run(host)
    expect(evs.some((e) => e.type === 'warn' && e.text.includes('loop-guard'))).toBe(true)
  })

  it('变化即清零：不同输出/不同参数不触发（正常会话零误伤）', async () => {
    const rounds: Delta[][] = [
      [{ type: 'text', text: `输出A${'x'.repeat(10)}` }, { type: 'tool_use_start', id: 'a1', name: 'echo' }, { type: 'tool_use_end', id: 'a1' }, { type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'text', text: `输出B${'y'.repeat(10)}` }, { type: 'tool_use_start', id: 'b1', name: 'echo' }, { type: 'tool_use_end', id: 'b1' }, { type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'text', text: `输出C${'z'.repeat(10)}` }, { type: 'done', stop_reason: 'end' }],
    ]
    const host = makeHost(rounds, [mkTool('echo', false, true)])
    const evs = collect(host)
    await run(host)
    expect(evs.some((e) => e.type === 'systemMsg' && e.text.includes('loop-guard'))).toBe(false)
    expect(evs.some((e) => e.type === 'warn' && e.text.includes('loop-guard'))).toBe(false)
  })
})

describe('M13-B2 审批超时', () => {
  it('挂起审批超时自动 reject：resolved outcome=timeout，工具拿到 false', async () => {
    const round: Delta[] = [
      { type: 'tool_use_start', id: 'w1', name: 'write-ish' },
      { type: 'tool_use_end', id: 'w1' },
      { type: 'done', stop_reason: 'tool_use' },
    ]
    const host = makeHost([round], [mkTool('write-ish', false, false)], {
      sandbox: { ...emptyShellConfig().sandbox, defaultMode: 'default' }, // 非 full-access → 走 confirm
      approvalTimeoutMs: 40,
    })
    const evs = collect(host) // 有订阅者 → confirm 挂起等待
    await run(host)
    for (let i = 0; i < 60 && !evs.some((e) => e.type === 'approval/resolved'); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const resolved = evs.find((e) => e.type === 'approval/resolved')
    expect(resolved).toMatchObject({ outcome: 'timeout' })
    host.dispose()
  })
})
