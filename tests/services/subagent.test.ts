/**
 * Subagent 测（M11-P2）：工厂产物 + 隔离面 + 返回契约 + transcript 落盘。
 * MockProvider 驱动子 runLoop（不发网络）；不测并发编排（P3 集成）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTaskTool, makeSubagentOpts, buildSubRegistry, subagentSystem, makeAgentLogger, setSubagentProgressHandler } from '../../src/services/subagent.js'
import type { SubagentDeps } from '../../src/services/subagent.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import type { Logger } from '../../src/services/logger.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import { homedir } from 'node:os'

class MockProvider implements LLMProvider {
  readonly type = 'mock'
  constructor(private readonly script: Delta[][]) {}
  private call = 0
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function fakeTool(name: string, readonly: boolean): Tool {
  return {
    name,
    description: name,
    input_schema: { type: 'object', properties: {} },
    readonly,
    async execute() {
      return { content: 'ok' }
    },
  }
}

function makeDeps(over: Partial<SubagentDeps> = {}): SubagentDeps {
  const reg = new ToolRegistryImpl()
  for (const t of [
    fakeTool('read_file', true),
    fakeTool('bash', false),
    fakeTool('ask_user', true),
    fakeTool('todo', true),
    fakeTool('task', true), // 主 registry 里的 task（裁剪后子代理不可见）
  ]) reg.register(t)
  return {
    getProviderReq: () => ({ name: 'test', baseURL: 'http://x', apiKey: 'sk', model: 'm' }),
    getProvider: () => new MockProvider([[{ type: 'text', text: '结论：完成' }, { type: 'done', stop_reason: 'end' }]]),
    logger: noopLogger,
    makeAfterTools: () => null,
    onBeforeWrite: async () => {},
    cwd: process.cwd(),
    registry: reg,
    projectInstructions: '项目规范内容',
    ...over,
  }
}

const ctx = { cwd: process.cwd(), signal: new AbortController().signal }

describe('buildSubRegistry（裁剪面）', () => {
  it('排除 task/ask_user/todo；explore 型再排除非 readonly', () => {
    const deps = makeDeps()
    const general = buildSubRegistry(deps.registry, 'general')
    const names = general.list().map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('bash')
    expect(names).not.toContain('task')
    expect(names).not.toContain('ask_user')
    expect(names).not.toContain('todo')

    const explore = buildSubRegistry(deps.registry, 'explore')
    const eNames = explore.list().map((t) => t.name)
    expect(eNames).toContain('read_file')
    expect(eNames).not.toContain('bash')
  })
})

describe('subagentSystem / makeAgentLogger', () => {
  it('两型骨架 + 项目级段注入；explore 带只读宣言', () => {
    const g = subagentSystem('general', '规范X')
    expect(g).toContain('独立子任务代理')
    expect(g).toContain('规范X')
    expect(g).not.toContain('只读调研')
    const e = subagentSystem('explore', '')
    expect(e).toContain('只读调研')
  })
  it('agentLogger 尾参注入 agentId（通道经 base 透传）', () => {
    const seen: Array<unknown[]> = []
    const base: Logger = {
      debug: () => {},
      info: (c, e2, p, i, a) => seen.push([c, e2, p, i, a]),
      warn: () => {},
      error: () => {},
    }
    makeAgentLogger(base, 'a-test1').info('loop', 'evt', { x: 1 }, 2)
    expect(seen[0]?.[4]).toBe('a-test1')
  })
})

describe('makeSubagentOpts（隔离面断言）', () => {
  it('maxIterations=25 / NoopHistory / confirm=deps.confirm / afterTools 注入', () => {
    const deps = makeDeps({ makeAfterTools: () => async () => ({ feedback: undefined }) })
    const opts = makeSubagentOpts(deps, 'a-x', '描述', 'general', ctx.signal)
    expect(opts.maxIterations).toBe(25)
    expect(typeof opts.confirm).toBe('function')
    expect(opts.afterTools).toBeDefined()
    expect(opts.onBeforeRequest).toBeDefined()
    expect(opts.tools.list().map((t) => t.name)).not.toContain('task')
  })
})

describe('makeTaskTool.execute（返回契约 + transcript）', () => {
  const transcriptDir = join(homedir(), '.ecode', 'agents')
  it('返回最后 assistant 文本；transcript 落盘', async () => {
    const deps = makeDeps()
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '查目录', prompt: '查 src 结构' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('结论：完成')
    // transcript：本例 agentId 随机——扫目录里最新的文件含 prompt 与结论
    const files = require('node:fs').readdirSync(transcriptDir) as string[]
    expect(files.length).toBeGreaterThan(0)
    const latest = files[files.length - 1]
    const body = readFileSync(join(transcriptDir, latest), 'utf8')
    expect(body).toContain('查 src 结构')
  })

  it('子循环致命错误转 is_error 可读文案（不炸父；catch 双保险）', async () => {
    // 非 CONTEXT 的 fatal（loop re-throw → task.execute catch → "子代理失败"文案）
    const boom: LLMProvider = {
      type: 'mock',
      async *run(): AsyncIterable<Delta> {
        throw Object.assign(new Error('连接被重置'), { code: 'ECONNRESET', recoverable: false, retryable: false })
      },
    }
    const deps = makeDeps({ getProvider: () => boom })
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '大任务', prompt: 'x' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('子代理失败')
  })

  it('子代理超窗（CONTEXT_TOO_LONG）：压缩兜底链消化后不产出 → 可读 is_error（双保险第二道）', async () => {
    // CONTEXT_TOO_LONG 在 loop 内走压缩兜底不抛出（P0-2）；压缩也失败（同一 mock 持续炸）
    // → loop warn 后 break → task 返回"未产出结论" is_error——两条路都不炸父
    const boom: LLMProvider = {
      type: 'mock',
      async *run(): AsyncIterable<Delta> {
        throw Object.assign(new Error('上下文超限'), { code: 'CONTEXT_TOO_LONG', recoverable: false, retryable: false })
      },
    }
    const deps = makeDeps({ getProvider: () => boom })
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '超大任务', prompt: 'x'.repeat(1000) }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('子代理')
  })

  it('进度桥：setSubagentProgressHandler 收运行中快照（onToolStart 更新活动，结束移除）', async () => {
    const snaps: Array<Array<{ id: string; description: string; activity: string }>> = []
    setSubagentProgressHandler((list) => snaps.push(list.map((x) => ({ ...x }))))
    const provider = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'read_file' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'end' },
      ],
      [{ type: 'text', text: '查完' }, { type: 'done', stop_reason: 'end' }],
    ])
    const deps = makeDeps({ getProvider: () => provider })
    const tool = makeTaskTool(deps)
    await tool.execute({ description: '调研', prompt: 'p' }, ctx)
    setSubagentProgressHandler(null)
    // 启动快照（activity=启动中）→ 工具活动快照 → 结束空快照
    expect(snaps.some((l) => l.length === 1 && l[0].description === '调研' && l[0].activity === '启动中')).toBe(true)
    expect(snaps.some((l) => l.length === 1 && l[0].activity === 'read_file')).toBe(true)
    expect(snaps.at(-1)).toEqual([])
  })
})
