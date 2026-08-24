/**
 * M13-B1 去重二连测试（方案 §10 分项测试点）：
 * skill 二连调第二次 notice / 不同 skill 不受影响 / rewind 后标记被投影 → 回未激活；
 * read 同文件第二次 skip / mtime 变化后放行（edit 后再读）/ 无宿主时不去重。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, HistoryLine } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { readFileTool } from '../../src/tools/builtin/read_file.js'
import { skillTool } from '../../src/tools/builtin/skill.js'
import type { ToolContext } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class MockProvider implements LLMProvider {
  readonly type = 'mock'
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    yield { type: 'done', stop_reason: 'end' }
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function makeHost(): HostSession {
  const reg = new ToolRegistryImpl()
  reg.register(readFileTool)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  return new HostSession({
    providerRegistry: { getByType: () => new MockProvider() } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator,
    skillListForPrompt: () => [],
  })
}

/** 往宿主 messages 塞一条含 skill 标记的 tool_result（模拟 skill 工具已执行） */
function injectSkillResult(host: HostSession, name: string): void {
  ;(host.transcript as HistoryLine[]).push(
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t-${name}`, name: 'skill', input: { skill: name } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t-${name}`, content: `<skill_content name="${name}">body</skill_content>` }],
    },
  )
}

const baseCtx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

describe('M13-B1 skill 去重（#3）', () => {
  it('已激活 skill：isSkillActive 命中 + 工具返回 notice（不返回全文）', async () => {
    const host = makeHost()
    injectSkillResult(host, 'alpha')
    expect(host.isSkillActive('alpha')).toBe(true)
    const r = await skillTool.execute({ skill: 'alpha' }, {
      ...baseCtx(process.cwd()),
      session: { isSkillActive: (n) => host.isSkillActive(n) },
    })
    expect(r.is_error).not.toBe(true)
    expect((r.content as string).startsWith('<skill_notice name="alpha">')).toBe(true)
  })

  it('不同 skill 不受影响（beta 未激活走原路径）', () => {
    const host = makeHost()
    injectSkillResult(host, 'alpha')
    expect(host.isSkillActive('beta')).toBe(false)
  })

  it('rewind 后标记区间被投影 → 判定自动回未激活', async () => {
    const host = makeHost()
    injectSkillResult(host, 'alpha')
    expect(host.isSkillActive('alpha')).toBe(true)
    // rewind 线：锚到 skill 调用的 toolUseId——投影截掉 [锚..rewind] 区间（含 skill 标记行）
    host.appendRewind({ rewind: true, toolUseId: 't-alpha' } as unknown as HistoryLine)
    expect(host.isSkillActive('alpha')).toBe(false)
  })

  it('无宿主（ctx.session 缺省）：不去重——走 registry 原路径', async () => {
    const r = await skillTool.execute({ skill: '不存在' }, baseCtx(process.cwd()))
    expect(r.is_error).toBe(true) // registry 未命中报不存在（原行为不变）
  })
})

describe('M13-B1 重复读去重（#4）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecode-dedup-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const makeCtx = (host: HostSession): ToolContext => ({
    cwd: dir,
    signal: new AbortController().signal,
    session: { readFileGuard: host.readFileGuard },
  })

  it('同文件第二次读 skip；内容不重复注入', async () => {
    const host = makeHost()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    const r1 = await readFileTool.execute({ path: 'a.txt' }, makeCtx(host))
    expect(r1.content).toBe('hello')
    const r2 = await readFileTool.execute({ path: 'a.txt' }, makeCtx(host))
    expect(r2.content).toContain('未变化')
    expect(r2.content).toContain('bash cat')
  })

  it('文件变化（mtime 变）后放行——edit/write 后再读', async () => {
    const host = makeHost()
    const f = join(dir, 'b.txt')
    writeFileSync(f, 'v1')
    await readFileTool.execute({ path: 'b.txt' }, makeCtx(host))
    writeFileSync(f, 'v2 changed')
    // 显式推 mtime（部分 FS 同秒写 mtime 分辨率不足）
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    const r = await readFileTool.execute({ path: 'b.txt' }, makeCtx(host))
    expect(r.content).toBe('v2 changed')
  })

  it('无宿主（ctx.session 缺省）：不去重', async () => {
    writeFileSync(join(dir, 'c.txt'), 'x')
    const r1 = await readFileTool.execute({ path: 'c.txt' }, baseCtx(dir))
    const r2 = await readFileTool.execute({ path: 'c.txt' }, baseCtx(dir))
    expect(r1.content).toBe('x')
    expect(r2.content).toBe('x') // 每次都真读
  })

  it('session/clear 后已读表重置', async () => {
    const host = makeHost()
    writeFileSync(join(dir, 'd.txt'), 'x')
    await readFileTool.execute({ path: 'd.txt' }, makeCtx(host))
    await host.send({ op: 'session/clear' })
    const r = await readFileTool.execute({ path: 'd.txt' }, makeCtx(host))
    expect(r.content).toBe('x') // clear 后重新真读
  })
})
