/**
 * Ctrl+C 立即停（用户拍板 2026-09-02）：审批挂起期 interrupt 的硬收敛——真机日志实证
 * （interrupt 到达 5 分钟轮不退）+ 探针连发复现路径的回归锁。
 * 场景：bash 工具（副作用）→ 审批挂起（无人应答）→ 发 interrupt → 断言：
 *   H1 审批立即收敛（approval/resolved cancelled——不等 15min 超时）
 *   H2 轮立即结束（whenIdle 秒回 + turn/completed 帧）
 *   H3 interrupt 后零新 provider 请求（审批拒绝回喂不再起下一迭代——迭代顶部硬检查）
 *   H4 并行残留轮全停（活跃 controller 集合——旧轮 controller 被替换后 interrupt 仍能停它）
 */
import { describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, Message } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore, type HistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

const bashTool: Tool = {
  name: 'bash',
  description: 'run shell',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: [] },
  readonly: false,
  async execute() {
    return { content: 'should not run' }
  },
}

function makeDeps(provider: LLMProvider): HostDeps {
  const reg = new ToolRegistryImpl()
  reg.register(bashTool)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  return {
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as Logger,
    history: new NoopHistoryStore() as HistoryStore,
    getConfig: () => config,
    orchestrator,
    skillListForPrompt: () => [],
    cwd: process.cwd(),
  }
}

const bashToolUse = (id: string): Delta[] => [
  { type: 'tool_use_start', id, name: 'bash' },
  { type: 'tool_use_delta', id, partial_json: '{"command":"echo x"}' },
  { type: 'tool_use_end', id },
  { type: 'done', stop_reason: 'tool_use' },
]

const flush = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('Ctrl+C 立即停（审批挂起期 interrupt 硬收敛）', () => {
  it('H1-H3：审批立即收敛 + 轮立即结束 + 零新请求', async () => {
    let calls = 0
    const p: LLMProvider = {
      type: 'mock',
      async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
        calls++
        yield { type: 'text', text: `t${calls}` }
        for (const d of bashToolUse(`u${calls}`)) yield d
      },
    }
    const host = new HostSession(makeDeps(p))
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: 'run', mode: 'StartOrSteer' })
    // 审批挂起（无人应答）
    await flush(150)
    expect(events.some((e) => e.type === 'approval/requested')).toBe(true)
    expect(calls).toBe(1)
    const t0 = Date.now()
    // Ctrl+C：interrupt
    const r = await host.send({ op: 'interrupt' })
    expect(r.ok).toBe(true)
    await host.whenIdle() // 轮立即结束（不等审批超时）
    const elapsed = Date.now() - t0
    // H2：立即（允许异步链误差，但远小于审批超时秒级——这里 <2s）
    expect(elapsed).toBeLessThan(2000)
    expect(events.some((e) => e.type === 'turn/completed')).toBe(true)
    // H1：审批已收敛（cancelled——不等 timeout）
    const resolved = events.find((e) => e.type === 'approval/resolved')
    expect(resolved).toMatchObject({ outcome: 'cancelled' })
    await flush(300)
    // H3：interrupt 后零新请求（审批拒绝回喂不再起下一迭代——迭代顶部/工具批硬检查）
    expect(calls).toBe(1)
    host.dispose()
  }, 15_000)
})

describe('Ctrl+C 立即停·审阅修复批回归', () => {
  it('H4 并行残留轮全停（controller 集合——真机双轮病理的直接对策）+ 按轮注销不误删', async () => {
    // 构造双轮：轮 A 挂审批（bash 副作用）→ 不中断直接再驱动轮 B 会走插话——改用直接注入：
    // 经 (host as any) 手工登记第二个 controller 模拟双轮残留（startTurn 竞态注入的同构面）
    let calls = 0
    const p: LLMProvider = {
      type: 'mock',
      async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
        calls++
        yield { type: 'text', text: `t${calls}` }
        for (const d of bashToolUse(`u${calls}`)) yield d
      },
    }
    const host = new HostSession(makeDeps(p))
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: 'run', mode: 'StartOrSteer' })
    await flush(150) // 轮 A 挂审批
    expect(calls).toBe(1)
    // 模拟双轮残留：手工再登记一个 controller（等价旧轮 controller 被替换后仍在集合）
    const ghost = new AbortController()
    const map = (host as unknown as { activeAbortControllers: Map<string, AbortController> }).activeAbortControllers
    map.set('ghost-turn', ghost)
    await host.send({ op: 'interrupt' })
    await flush(50)
    expect(ghost.signal.aborted).toBe(true) // H4：残留轮 controller 也被打断
    await host.whenIdle()
    await flush(200)
    expect(calls).toBe(1) // 零新请求
    host.dispose()
  }, 15_000)

  it('审阅修复：中断路径 tool_use/tool_result 恒配对（流中中断——assistant 固化 tool_use 后 break 前补占位）', async () => {
    // gate 挂起流中：tool_use 已封口、done 未发——此刻中断 → finally 固化 tool_use →
    // stopReason aborted → break 前应合成占位 tool_result（否则落盘孤儿，恢复依赖投影层兜底）
    const g = Promise.withResolvers<void>()
    const p: LLMProvider = {
      type: 'mock',
      async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
        yield { type: 'text', text: 't' }
        yield { type: 'tool_use_start', id: 'u1', name: 'bash' }
        yield { type: 'tool_use_delta', id: 'u1', partial_json: '{"command":"echo x"}' }
        yield { type: 'tool_use_end', id: 'u1' }
        await g.promise // 挂在 done 前（流中窗口）
        yield { type: 'done', stop_reason: 'tool_use' }
      },
    }
    const host = new HostSession(makeDeps(p))
    await host.send({ op: 'prompt', text: 'run', mode: 'StartOrSteer' })
    await flush(150) // 流到 tool_use_end 后挂起
    await host.send({ op: 'interrupt' })
    g.resolve() // 中断已发，放行流（SDK abort 真机语义：静默收尾——mock 手动收）
    await host.whenIdle()
    await flush(100)
    // 断言配对：messages 里每个 tool_use 都有同 id 的 tool_result（中断占位）
    const msgs = (host as unknown as { messages: Message[] }).messages
    const useIds = new Set<string>()
    for (const m of msgs) {
      if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') useIds.add(b.id)
    }
    expect(useIds.size).toBe(1)
    const resultIds = new Set<string>()
    for (const m of msgs) {
      if (m.role === 'user') for (const b of m.content) if (b.type === 'tool_result') resultIds.add(b.tool_use_id)
    }
    expect(resultIds.has('u1')).toBe(true) // 占位配对在位——无孤儿 tool_use 落盘
    host.dispose()
  }, 15_000)

  it('审阅修复：中断后到达的新输入照常续投（afterAbort 打标——不再滞留死轮队列）', async () => {
    let calls = 0
    let sawInterruptTask = false
    const p: LLMProvider = {
      type: 'mock',
      async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
        calls++
        const last = (req.messages ?? []).at(-1)
        const text = Array.isArray(last?.content) ? last.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
        sawInterruptTask = sawInterruptTask || text.includes('新任务')
        yield { type: 'text', text: `t${calls}` }
        if (calls === 1) for (const d of bashToolUse(`u${calls}`)) yield d
        else yield { type: 'done', stop_reason: 'end' }
      },
    }
    const host = new HostSession(makeDeps(p))
    await host.send({ op: 'prompt', text: 'run', mode: 'StartOrSteer' })
    await flush(150) // 挂审批
    await host.send({ op: 'interrupt' })
    await host.whenIdle()
    // 中断后立刻发新输入（模拟用户看到「已停」反馈后的新任务意图）
    const r = await host.send({ op: 'prompt', text: '新任务', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    await host.whenIdle()
    await flush(200)
    expect(sawInterruptTask).toBe(true) // 新输入到达了模型（续投/或 running 已 false 直接新轮——不滞留）
    host.dispose()
  }, 15_000)
})
