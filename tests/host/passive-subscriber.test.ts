/**
 * D1 回归（2026-08-31 全功能走查）：单次模式 stdout 适配器是「观察型」订阅（canAnswer:false，
 * 与 runOnce 一致），不得撑起审批应答面——否则：
 * - --yes（auto-approve）：approval.ts 快速放行要求零订阅者，永不可达 → suspendOnce 悬空 →
 *   事件循环清空进程静默 exit 0（用户看到：无答案、无报错、退出码 0）；
 * - ask：无订阅者 fail-closed 拒绝分支同样不可达 → 同样挂死。
 * 修复后语义：观察型订阅不计入 subscriberCount（M14-C2⑧ 通道语义），单次模式
 * auto-approve 放行 tool-confirm；ask fail-closed 拒绝并喂回模型继续产出回答。
 */
import { describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class MockProvider implements LLMProvider {
  private call = 0
  constructor(private readonly script: Delta[][]) {}
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** 副作用工具（readonly:false）——default 档下走 tool-confirm 审批 */
const sideTool: Tool = {
  name: 'sideeffect',
  description: 'side-effect probe tool',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: false,
  async execute() {
    return { content: 'ran' }
  },
}

function makeHost(policy: 'ask' | 'auto-approve'): { host: HostSession; events: ProtocolEvent[] } {
  const reg = new ToolRegistryImpl()
  reg.register(sideTool)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: {
      m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 },
    },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  const deps: HostDeps = {
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator,
    skillListForPrompt: () => [],
  }
  const provider = new MockProvider([
    [
      { type: 'tool_use_start', id: 't1', name: 'sideeffect' },
      { type: 'tool_use_end', id: 't1' },
      { type: 'done', stop_reason: 'tool_use' },
    ],
    [
      { type: 'text', text: '最终回答' },
      { type: 'done', stop_reason: 'end' },
    ],
  ])
  const host = new HostSession({ ...deps, approvalPolicy: policy, cwd: mkdtempSync(join(tmpdir(), 'ecode-d1-')) })
  // 与 runOnce 相同形态：stdout 适配器 = 观察型订阅（不参与审批应答）
  const events: ProtocolEvent[] = []
  host.subscribe((e) => events.push(e), { canAnswer: false })
  return { host, events }
}

describe('D1 单次模式观察型订阅不撑起审批应答面', () => {
  it('--yes（auto-approve）：零可应答订阅者走快速放行，工具执行、轮完成', async () => {
    const { host, events } = makeHost('auto-approve')
    const r = await host.send({ op: 'prompt', text: '跑一下', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    await host.whenIdle()
    const toolDone = events.find((e) => e.type === 'item/completed' && e.name === 'sideeffect')
    expect(toolDone).toBeDefined()
    expect((toolDone as { isError?: boolean }).isError).toBeFalsy()
    expect(events.some((e) => e.type === 'delta' && e.text === '最终回答')).toBe(true)
    // 末事件可能是轮后的 thread/status——断言 completed 存在即可
    expect(events.some((e) => e.type === 'turn/completed')).toBe(true)
  }, 5000)

  it('ask（无 --yes）：零可应答订阅者 fail-closed 拒绝，模型收到拒绝反馈继续产出回答，轮完成不挂', async () => {
    const { host, events } = makeHost('ask')
    const r = await host.send({ op: 'prompt', text: '跑一下', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    await host.whenIdle()
    const toolDone = events.find((e) => e.type === 'item/completed' && e.name === 'sideeffect')
    expect(toolDone).toBeDefined()
    expect((toolDone as { isError?: boolean }).isError).toBe(true)
    expect(events.some((e) => e.type === 'delta' && e.text === '最终回答')).toBe(true)
    expect(events.some((e) => e.type === 'turn/completed')).toBe(true)
  }, 5000)
})
