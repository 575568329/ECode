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

  it('M14-C1②：/api/events 退役 410（mux 唯一事件面）；cmd 通路不受影响', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/events`, { headers: { authorization: `Bearer ${srv.token}` } })
    expect(r.status).toBe(410)
    const r2 = await client.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    expect(r2).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle()
  })

  it('token 不可猜测性 + loopback 判定单测（抽函数直测——socket.remoteAddress 无法在回环测试中伪造）', async () => {
    expect(srv.token.length).toBeGreaterThanOrEqual(32) // randomBytes(24) hex=48
    // loopback 白名单语义（真实 403 路径无法用 127.0.0.1 客户端伪造——用判定逻辑直测锁定）
    const { LOOPBACK_ADDRS } = await import('../../src/server/loopback.js')
    expect(LOOPBACK_ADDRS.has('127.0.0.1')).toBe(true)
    expect(LOOPBACK_ADDRS.has('::1')).toBe(true)
    expect(LOOPBACK_ADDRS.has('::ffff:127.0.0.1')).toBe(true)
    expect(LOOPBACK_ADDRS.has('192.168.1.5')).toBe(false)
    expect(LOOPBACK_ADDRS.has('8.8.8.8')).toBe(false)
  })
})
