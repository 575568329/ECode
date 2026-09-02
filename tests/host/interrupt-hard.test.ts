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
