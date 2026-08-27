/**
 * M13-W1 ProjectHost 测试：两层宿主的容器语义。
 *
 * 覆盖：ensure 幂等、双会话隔离（messages/usage/broker 各归各）、多项目 skill hooks
 * 隔离（审阅 P0-1：A 项目 /clear 不清 B）、桥归属守卫（A dispose 不误清后挂 B 的模块槽——P0-2）、
 * 默认会话语义（首个 ensure 转正 / 收后不持久化）、活跃度聚合。
 */

import { describe, expect, it, afterAll } from 'vitest'
import { ProjectHost } from '../../src/host/project.js'
import type { HostDeps } from '../../src/host/session.js'
import { HostSession } from '../../src/host/session.js'
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
import { currentPermissionAsker, setPermissionAsker } from '../../src/services/permissions.js'

class MockProvider implements LLMProvider {
  readonly type = 'mock'
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    yield { type: 'text', text: `reply-${_req.messages.length}` }
    yield { type: 'done', stop_reason: 'end' }
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  async execute() {
    return { content: 'ok' }
  },
}

function makeHostDeps(provider: LLMProvider, sessionId = 's-test'): HostDeps {
  const reg = new ToolRegistryImpl()
  reg.register(echoTool)
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
  // M14-C3②：asker 槽键 = currentSessionId——Noop 恒空串会让两会话同键（键控失效），
  // 固定 id 子类让测试路径与真实 FileHistoryStore 语义一致
  class FixedIdHistory extends NoopHistoryStore {
    constructor(private readonly fixedId: string) { super() }
    currentSessionId(): string { return this.fixedId }
  }
  return {
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new FixedIdHistory(sessionId),
    getConfig: () => config,
    orchestrator,
    skillListForPrompt: () => [],
  }
}

const collect = (host: HostSession): ProtocolEvent[] => {
  const events: ProtocolEvent[] = []
  host.subscribe((ev) => events.push(ev))
  return events
}

const drain = async (host: HostSession): Promise<void> => {
  await host.whenIdle()
}

function makeProject(autoMountBridges?: boolean): ProjectHost {
  return new ProjectHost({
    createConversation: (sid) => makeHostDeps(new MockProvider()),
    ...(autoMountBridges === false ? { autoMountBridges: false } : {}),
  })
}

describe('ProjectHost（M13-W1）', () => {
  it('ensure 幂等：同 id 返回同一实例；不同 id 各自独立', () => {
    const p = makeProject(true)
    const a1 = p.ensure('s-a')
    const a2 = p.ensure('s-a')
    expect(a1).toBe(a2)
    const b = p.ensure('s-b')
    expect(b).not.toBe(a1)
    expect(p.size).toBe(2)
    expect(p.currentSessionId).toBe('s-a') // 首个 ensure 转正默认
  })

  it('双会话隔离：A 会话的对话不进 B 的 transcript/事件流', async () => {
    const p = makeProject(true)
    const a = p.ensure('s-a')
    const b = p.ensure('s-b')
    const evB = collect(b)
    const r = await a.send({ op: 'prompt', text: '只在 A 说', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    await drain(a)
    expect(a.transcript.length).toBeGreaterThan(0)
    expect(b.transcript.length).toBe(0) // B 完全未受影响
    expect(evB.some((e) => e.type === 'delta')).toBe(false) // B 的事件流无 A 的 delta
  })

  it('session/clear 只清本会话 messages（隔离面）', async () => {
    const p = makeProject(true)
    const a = p.ensure('s-a')
    const b = p.ensure('s-b')
    await a.send({ op: 'prompt', text: 'A 内容', mode: 'StartOrSteer' })
    await drain(a)
    expect(a.transcript.length).toBeGreaterThan(0)
    await a.send({ op: 'session/clear' })
    expect(a.transcript.length).toBe(0)
    // B 无内容本就不受影响；再跑一轮 B 确认通道活着
    await b.send({ op: 'prompt', text: 'B 内容', mode: 'StartOrSteer' })
    await drain(b)
    expect(b.transcript.length).toBeGreaterThan(0)
  })

  it('多项目 skill hooks 隔离（审阅 P0-1）：A 项目 unregisterAll 不清 B 项目 registry', () => {
    const pa = new ProjectHost({ createConversation: (sid) => makeHostDeps(new MockProvider()) })
    const pb = new ProjectHost({ createConversation: (sid) => makeHostDeps(new MockProvider()) })
    const hook = [{ event: 'UserPromptSubmit' as const, command: 'echo hi' }]
    pa.skillHooks.register('alpha', hook)
    pb.skillHooks.register('beta', hook)
    pa.skillHooks.unregisterAll()
    expect(pa.extHooks.entries().some((e) => e.owner === 'skill:alpha')).toBe(false)
    expect(pb.extHooks.entries().some((e) => e.owner === 'skill:beta')).toBe(true) // B 项目不受 A 项目 /clear 影响
  })

  it('M14-C3② asker 键控：两会话挂桥互不覆盖（各挂各键）；dispose 各清各键（串台与误清双防）', () => {
    const pa = new ProjectHost({ createConversation: (sid) => makeHostDeps(new MockProvider(), sid) })
    const pb = new ProjectHost({ createConversation: (sid) => makeHostDeps(new MockProvider(), sid) })
    const a = pa.ensure('s-a') // 挂 A 的桥（键 's-a'）
    const b = pb.ensure('s-b') // 挂 B 的桥（键 's-b'——键控下不再覆盖 A）
    expect(currentPermissionAsker('s-a')).not.toBeNull()
    expect(currentPermissionAsker('s-b')).not.toBeNull()
    expect(currentPermissionAsker('s-a')).not.toBe(currentPermissionAsker('s-b'))
    a.dispose() // A 销毁——只清自己的键
    expect(currentPermissionAsker('s-a')).toBeNull()
    expect(currentPermissionAsker('s-b')).not.toBeNull() // B 不受影响
    b.dispose()
    expect(currentPermissionAsker('s-b')).toBeNull()
  })

  it('disposeConversation：默认会话被收后 currentSessionId 置空，ensureDefault 重建新默认', () => {
    const p = makeProject(true)
    p.ensure('s-a')
    expect(p.currentSessionId).toBe('s-a')
    expect(p.disposeConversation('s-a')).toBe(true)
    expect(p.currentSessionId).toBe('')
    const fresh = p.ensureDefault('s-new')
    expect(p.currentSessionId).toBe('s-new')
    expect(fresh).toBe(p.conversation('s-new'))
  })

  it('活跃度聚合：任一会话有订阅者则项目 subscriberCount>0', () => {
    const p = makeProject(true)
    const a = p.ensure('s-a')
    p.ensure('s-b')
    expect(p.subscriberCount).toBe(0)
    const unsub = a.subscribe(() => {})
    expect(p.subscriberCount).toBe(1)
    unsub()
    expect(p.subscriberCount).toBe(0)
  })
})

describe('ProjectHost M13-W2（restore=ensure / 会话级 sweep）', () => {
  // M14-C3②：asker 键控需要 currentSessionId——spread 会丢 Noop 原型方法，改子类形态
  let stubSeq = 0
  const mkConvDeps = (lines: HistoryLine[] = []) => {
    class StubHistory extends NoopHistoryStore {
      constructor() { super() }
      restoreFull(): HistoryLine[] { return lines }
      currentSessionId(): string { return `stub-${++stubSeq}` }
    }
    return { ...makeHostDeps(new MockProvider()), history: new StubHistory() }
  }

  it('ensureRestore 冷会话：载入 restoreFull 内容为新会话', async () => {
    const lines: HistoryLine[] = [{ role: 'user', content: [{ type: 'text', text: '历史消息' }] }]
    const p = new ProjectHost({ createConversation: () => mkConvDeps(lines) })
    const h = await p.ensureRestore('cold-1')
    expect(h.transcript.length).toBe(1)
    expect(p.conversation('cold-1')).toBe(h)
  })

  it('ensureRestore 活会话复用：不重复载入（restoreFull 不再调）', async () => {
    let loads = 0
    const p = new ProjectHost({
      createConversation: () => {
        loads++
        return mkConvDeps([])
      },
    })
    const first = p.ensure('live-1')
    const second = await p.ensureRestore('live-1')
    expect(second).toBe(first)
    expect(loads).toBe(1)
  })

  it('ensureRestore 并发单飞：同 id 并发只装配一次', async () => {
    let created = 0
    const p = new ProjectHost({
      createConversation: () => {
        created++
        return mkConvDeps([])
      },
    })
    const [a, b] = await Promise.all([p.ensureRestore('race-1'), p.ensureRestore('race-1')])
    expect(a).toBe(b)
    expect(created).toBe(1)
  })

  it('sweepSessions：闲置回收；订阅者闸拦截；默认被收后置空', () => {
    const p = makeProject(true)
    const a = p.ensure('s-a')
    p.ensure('s-b')
    const unsub = a.subscribe(() => {}) // a 有订阅者 → 三闸拦截
    expect(p.sweepSessions(0)).toBe(1) // 只收了 b
    expect(p.conversation('s-b')).toBeUndefined()
    expect(p.conversation('s-a')).toBe(a)
    unsub()
    expect(p.sweepSessions(0)).toBe(1) // a 无闸了 → 收
    expect(p.currentSessionId).toBe('') // 默认被收 → 置空
  })
})

// 模块槽卫生：本文件动过 permissionAsker 槽，收尾清空防串到其他用例（M14-C3② 键控——本文件测试键）
afterAll(() => {
  setPermissionAsker('s-a', null)
  setPermissionAsker('s-b', null)
})
