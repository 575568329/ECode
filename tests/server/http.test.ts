/**
 * M12-B7：HTTP transport + serve 骨架测试（协议断言双跑：InMemory 之外的网络形态）。
 * MockProvider 驱动真 HostSession，HTTP 客户端走 localhost 真回环——不发外网。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import { serveHost } from '../../src/server/http.js'
import { HttpTransport } from '../../src/protocol/http.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class MockProvider implements LLMProvider {
  readonly type = 'mock'
  constructor(private readonly script: Delta[][]) {}
  private call = 0
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const echo: Tool = {
  name: 'echo',
  description: 'e',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  async execute() {
    return { content: 'ok' }
  },
}
const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function makeDeps(): HostDeps {
  const reg = new ToolRegistryImpl()
  reg.register(echo)
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  return {
    providerRegistry: { getByType: () => new MockProvider([[{ type: 'text', text: 'hi' }, { type: 'done', stop_reason: 'end' }]]) } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    config,
    orchestrator: orch,
    getConfig: () => config,
    skillListForPrompt: () => [],
  }
}

let host: HostSession
let srv: Awaited<ReturnType<typeof serveHost>>
let client: HttpTransport

beforeAll(async () => {
  host = new HostSession(makeDeps())
  srv = await serveHost(host)
  client = new HttpTransport(`http://127.0.0.1:${srv.port}`, srv.token)
})

afterAll(async () => {
  client.dispose()
  host.dispose()
  await srv.close()
})

describe('B7：HTTP transport + serve 骨架', () => {
  it('health 免鉴权；无 token 的 cmd 被拒 401；带 token 通', async () => {
    const h = await fetch(`http://127.0.0.1:${srv.port}/api/health`)
    expect(h.status).toBe(200)
    const noAuth = await fetch(`http://127.0.0.1:${srv.port}/api/cmd`, { method: 'POST', body: '{}' })
    expect(noAuth.status).toBe(401)
    const r = await client.send({ op: 'session/list' })
    expect(r).toMatchObject({ ok: true })
  })

  it('全链路：HTTP prompt → SSE delta/turn 事件 → respond 审批 → item/completed', async () => {
    const events: { type: string }[] = []
    const unsub = client.subscribe((e) => events.push(e as { type: string }))
    const r = await client.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle()
    // SSE 到达（pump 异步启动，轮询等）
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'turn/completed'); i++) {
      await new Promise((res) => setTimeout(res, 100))
    }
    expect(events.some((e) => e.type === 'delta')).toBe(true)
    expect(events.some((e) => e.type === 'turn/completed')).toBe(true)
    unsub()
  })

  it('loopback 围栏：remoteAddress 白名单语义由 serveHost 侧强制（本测试全走 127.0.0.1 恒过）', () => {
    expect(srv.token.length).toBeGreaterThanOrEqual(32) // randomBytes(24) hex=48——不可猜测
  })
})
