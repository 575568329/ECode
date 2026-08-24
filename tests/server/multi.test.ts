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
import { ProjectHost } from '../../src/host/project.js'
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

const seenCwds: string[] = []
const mk = (cwd: string): HostDeps => {
  // M13-W2：工厂改为项目视角（registry 存 ProjectHost；会话 Map 内含首会话）
  seenCwds.push(cwd)
  const reg = new ToolRegistryImpl()
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
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

const createdProjects: ProjectHost[] = []
const registry = new ProjectRegistry({
  createSession: (cwd) => {
    // 对齐 cli 装配：ensureConversation 端口晚绑定 projectRef（session/restore 经 dispatch 落 ProjectHost）
    const projectRef: { current?: ProjectHost } = {}
    const p = new ProjectHost({
      createConversation: () => ({
        ...mk(cwd),
        ensureConversation: async (sid) => {
          if (projectRef.current === undefined) return { ok: false, error: 'no project', code: 'NOT_IMPLEMENTED' }
          await projectRef.current.ensureRestore(sid)
          return { ok: true, sessionId: sid }
        },
      }),
    })
    projectRef.current = p
    const first = p.ensure('sess-A')
    created.push(first)
    createdProjects.push(p)
    return p
  },
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
    expect(created.length).toBe(2) // 两项目各装配一个 ProjectHost 首会话
    expect(seenCwds).toContain(dirA.split(String.fromCharCode(92)).join('/')) // cwd 真接线（审阅 P0-1：曾 void cwd 掩护断线）
    expect(seenCwds).toContain(dirB.split(String.fromCharCode(92)).join('/'))
  })

  it('need-confirm 栅栏：未注册项目首次拉起 428；confirm 后放行', async () => {
    const dirC = mkdtempSync(join(tmpdir(), 'ecode-projC-'))
    const r1 = await (await fetch(`${base}/api/p/${enc(dirC)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/list' }) })).json()
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('confirm') })
    const r2 = await (await fetch(`${base}/api/p/${enc(dirC)}/cmd?confirm=true`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/list' }) })).json()
    expect(r2).toMatchObject({ ok: true })
    rmSync(dirC, { recursive: true, force: true })
  })

  it('M13-W2 命令信封三态：显式命中/冷会话 404/缺省走默认并回执 sessionId', async () => {
    const pA = enc(dirA)
    // ①显式 sessionId：命中项目首会话 sess-A
    const r1 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'sess-A', op: { op: 'session/list' } }) })).json()
    expect(r1).toMatchObject({ ok: true, sessionId: 'sess-A' })
    // ①冷会话非 restore → 404
    const r2 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: '不存在的会话', op: { op: 'session/list' } }) })).json()
    expect(r2).toMatchObject({ ok: false })
    // ①冷会话 restore 可拉起（NoopHistory 空载入 → ok）
    const r3 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'cold-x', op: { op: 'session/restore', sessionId: 'cold-x' } }) })).json()
    expect(r3).toMatchObject({ ok: true, sessionId: 'cold-x' })
    // ②缺省 → 默认会话（sess-A）回执
    const r4 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/list' } }) })).json()
    expect(r4).toMatchObject({ ok: true, sessionId: 'sess-A' })
    // 过渡兼容：裸 ProtocolCommand（无信封）仍可用
    const r5 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/list' }) })).json()
    expect(r5).toMatchObject({ ok: true, sessionId: 'sess-A' })
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
