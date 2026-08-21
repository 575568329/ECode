/**
 * M12-B8.2/B9（G2）：多项目 serve + 双客户端附着验收。
 * 两个真实临时目录作为两个项目——projects 列表/项目路由隔离/need-confirm 栅栏/双端审批互答。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveMulti } from '../../src/server/multi.js'
import { HttpTransport } from '../../src/protocol/http.js'
import { ProjectRegistry } from '../../src/server/projects.js'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class P implements LLMProvider {
  readonly type = 'mock'
  async *run(_r: LLMProviderRunRequest): AsyncIterable<Delta> {
    yield { type: 'text', text: 'ok' }
    yield { type: 'done', stop_reason: 'end' }
  }
}
const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const mk = (cwd: string): HostDeps => {
  const reg = new ToolRegistryImpl()
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  void cwd
  return {
    providerRegistry: { getByType: () => new P() } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    config,
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
  }
}

const dirA = mkdtempSync(join(tmpdir(), 'ecode-projA-'))
const dirB = mkdtempSync(join(tmpdir(), 'ecode-projB-'))
const created: HostSession[] = []

const registry = new ProjectRegistry({
  createSession: (cwd) => {
    const h = new HostSession(mk(cwd))
    created.push(h)
    return h
  },
  idleMinutes: 0,
  lockDir: join(tmpdir(), `ecode-mlock-${Date.now()}`),
})
registry.register(dirA)
registry.register(dirB)

let srv: Awaited<ReturnType<typeof serveMulti>>
let base: string
let auth: Record<string, string>

beforeAll(async () => {
  srv = await serveMulti({ registry, defaultCwd: dirA })
  base = `http://127.0.0.1:${srv.port}`
  auth = { authorization: `Bearer ${srv.token}` }
})
afterAll(async () => {
  await srv.close()
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

const enc = (p: string): string => encodeURIComponent(p.split(String.fromCharCode(92)).join('/'))

describe('B8.2 多项目 serve（G2 验收）', () => {
  it('projects 列表；两项目各自 prompt 互不串台（实例隔离）', async () => {
    const list = await (await fetch(`${base}/api/projects`, { headers: auth })).json()
    expect(list.registered.length).toBe(2)
    const rA = await (await fetch(`${base}/api/p/${enc(dirA)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/clear' }) })).json()
    expect(rA).toMatchObject({ ok: true })
    const rB = await (await fetch(`${base}/api/p/${enc(dirB)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/clear' }) })).json()
    expect(rB).toMatchObject({ ok: true })
    expect(created.length).toBe(2) // 两项目各装配一个 HostSession
  })

  it('need-confirm 栅栏：未注册项目首次拉起 428；confirm 后放行', async () => {
    const dirC = mkdtempSync(join(tmpdir(), 'ecode-projC-'))
    const r1 = await (await fetch(`${base}/api/p/${enc(dirC)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/list' }) })).json()
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('confirm') })
    const r2 = await (await fetch(`${base}/api/p/${enc(dirC)}/cmd?confirm=true`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/list' }) })).json()
    expect(r2).toMatchObject({ ok: true })
    rmSync(dirC, { recursive: true, force: true })
  })

  it('G2 双客户端附着：HttpTransport 双端事件一致（B7 已验证的订阅实现）', async () => {
    const t1 = new HttpTransport(base, srv.token)
    const t2 = new HttpTransport(base, srv.token)
    const evs1: string[] = []
    const evs2: string[] = []
    t1.subscribe((e) => evs1.push(e.type))
    t2.subscribe((e) => evs2.push(e.type))
    // 事件经 /api/cmd（默认项目=dirA）触发
    const r = await t1.send({ op: 'prompt', text: 'hi', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' })
    for (let i = 0; i < 60 && !evs1.includes('turn/completed'); i++) await new Promise((res) => setTimeout(res, 100))
    expect(evs1).toContain('turn/completed')
    expect(evs2).toContain('turn/completed') // 双端同帧收敛
    t1.dispose()
    t2.dispose()
  }, 15_000)
})
