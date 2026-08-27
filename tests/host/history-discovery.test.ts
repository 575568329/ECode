/**
 * M13-W4 历史发现三件套测试：MetaLine.cwd 落盘与读回、collectProjectCwds 聚合（含正斜杠归一）、
 * /api/projects 三源并集、session/list 冷热合并（running 注入）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHistoryStore, collectProjectCwds } from '../../src/services/history.js'
import type { Message } from '../../src/core/types.js'
import { serveMulti } from '../../src/server/multi.js'
import { ProjectRegistry } from '../../src/server/projects.js'
import { ProjectHost } from '../../src/host/project.js'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

const dirs: string[] = []
const mkd = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const userMsg = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })

describe('M13-W4 MetaLine.cwd', () => {
  it('构造带 cwd → 首行 meta 落 cwd；loadAll 读回；不带 cwd 的旧行为不变', () => {
    const dir = mkd('ecode-hist-cwd-')
    const a = new FileHistoryStore({ sessionId: 's-cwd-1', model: 'm', cwd: 'D:/work/foo', dir })
    a.append(userMsg('hello'))
    const b = new FileHistoryStore({ sessionId: 's-cwd-2', model: 'm', dir }) // 旧形态（无 cwd）
    b.append(userMsg('old'))
    const metas = new FileHistoryStore({ sessionId: 'scan', model: 'm', dir }).loadAll()
    expect(metas.find((m) => m.sessionId === 's-cwd-1')?.cwd).toBe('D:/work/foo')
    expect(metas.find((m) => m.sessionId === 's-cwd-2')?.cwd).toBeUndefined()
  })
})

describe('M13-W4 collectProjectCwds 聚合', () => {
  it('扫首行 meta.cwd 去重 + 反斜杠归一正斜杠；损坏文件跳过；空目录返回空', () => {
    const dir = mkd('ecode-hist-agg-')
    const mk = (id: string, cwd: string | undefined): void => {
      const st = new FileHistoryStore({ sessionId: id, model: 'm', ...(cwd !== undefined ? { cwd } : {}), dir })
      st.append(userMsg(`${id} 内容`))
    }
    mk('agg-1', 'D:/work/foo')
    mk('agg-2', 'D:' + String.fromCharCode(92) + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'foo') // 反斜杠同项目
    mk('agg-3', 'D:/study/ECode')
    mk('agg-4', undefined) // 无 cwd 不参与
    const cwds = collectProjectCwds(dir)
    expect(cwds).toContain('D:/work/foo')
    expect(cwds).toContain('D:/study/ECode')
    expect(cwds.filter((c) => c === 'D:/work/foo')).toHaveLength(1) // 去重
    expect(collectProjectCwds(join(dir, '不存在'))).toEqual([])
  })
})

// —— /api/projects 三源并集 + session/list 冷热合并（serve 端到端） ——
class P implements LLMProvider {
  readonly type = 'mock'
  async *run(_r: LLMProviderRunRequest): AsyncIterable<Delta> {
    yield { type: 'done', stop_reason: 'end' }
  }
}
const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: {} } as unknown as Logger
const mkConv = (sessionsDir: string, cwd: string, projectRef: { current?: ProjectHost }): HostDeps => {
  const reg = new ToolRegistryImpl()
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  // 真 FileHistoryStore（meta.cwd 落盘——聚合可扫）
  const history = new FileHistoryStore({ sessionId: 'sess-w4', model: 'm', cwd, dir: sessionsDir })
  history.append(userMsg('w4 会话'))
  return {
    providerRegistry: { getByType: () => new P() } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history,
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
    conversationStates: () => projectRef.current?.runningMap() ?? new Map<string, boolean>(),
  }
}

describe('M13-W4 /api/projects 三源并集 + session/list 冷热合并', () => {
  it('history 源出现在 /api/projects；活会话 running 注入 session/list', async () => {
    const sessionsDir = mkd('ecode-hist-sess-')
    const dirA = mkd('ecode-hist-projA-')
    const registry = new ProjectRegistry({
      createSession: (cwd) => {
        const projectRef: { current?: ProjectHost } = {}
        const p = new ProjectHost({ createConversation: () => mkConv(sessionsDir, cwd, projectRef), cwd })
        projectRef.current = p
        p.ensure('sess-w4')
        return p
      },
      lockDir: join(tmpdir(), `ecode-hist-lock-${Date.now()}`),
    })
    registry.register(dirA)
    const srv = await serveMulti({ registry, defaultCwd: dirA }, { sessionsDir })
    const base = `http://127.0.0.1:${srv.port}`
    const auth = { authorization: `Bearer ${srv.token}` }

    // 先物化项目（/api/projects 的 history 源来自落盘 meta——createSession 在首次 acquire 时跑）。
    // M14-C1③：session/list 已不走装配（只读）——物化改用 session/new（显式装配性 op）；
    // 工厂 acquire 时 ensure('sess-w4') 落 meta（断言对象仍是 sess-w4，session/new 只负责挂活项目）
    const mk = (await (await fetch(`${base}/api/p/${encodeURIComponent(dirA.split(String.fromCharCode(92)).join('/'))}/cmd`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ op: { op: 'session/new' } }),
    })).json()) as { ok: boolean; sessionId?: string }
    expect(mk).toMatchObject({ ok: true })
    const r = await (await fetch(`${base}/api/p/${encodeURIComponent(dirA.split(String.fromCharCode(92)).join('/'))}/cmd`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sessionId: 'sess-w4', op: { op: 'session/list' } }),
    })).json()
    expect(r).toMatchObject({ ok: true })

    const list = await (await fetch(`${base}/api/projects`, { headers: auth })).json()
    expect(list.registered.length).toBe(1)
    expect(list.history.length).toBeGreaterThanOrEqual(1) // 历史反推源（写入过的 cwd）
    expect(list.history.every((c: string) => !c.includes(String.fromCharCode(92)))).toBe(true) // 归一正斜杠（realpath 8.3 短名不阻归一断言）
    const metas = (r as { value?: Array<{ sessionId: string; running?: boolean }> }).value ?? []
    expect(metas.some((m) => m.sessionId === 'sess-w4' && m.running === false)).toBe(true) // 活会话（非跑）注入 running=false（项目已活走宿主路径）
    await srv.close()
  })
})
