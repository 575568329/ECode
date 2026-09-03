/**
 * Subagent 测（M11-P2）：工厂产物 + 隔离面 + 返回契约 + transcript 落盘。
 * MockProvider 驱动子 runLoop（不发网络）；不测并发编排（P3 集成）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTaskTool, makeSubagentOpts, buildSubRegistry, SubRegistry, subagentSystem, makeAgentLogger, setSubagentProgressHandler, setSubagentBridge } from '../../src/services/subagent.js'
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
  it('maxIterations 缺省=50（2026-09-03 拍板跟主代理）/ NoopHistory / confirm=deps.confirm / afterTools 注入', () => {
    const deps = makeDeps({ makeAfterTools: () => async () => ({ feedback: undefined }) })
    const opts = makeSubagentOpts(deps, 'a-x', '描述', 'general', ctx.signal)
    expect(opts.maxIterations).toBe(50)
    expect(typeof opts.confirm).toBe('function')
    expect(opts.afterTools).toBeDefined()
    expect(opts.onBeforeRequest).toBeDefined()
    expect(opts.tools.list().map((t) => t.name)).not.toContain('task')
  })
  it('getMaxIterations 注入与显式入参两路轮数（deps getter > 兜底 50）；system getter 轮数感知', () => {
    const viaDeps = makeSubagentOpts(makeDeps({ getMaxIterations: () => 30 }), 'a-x', '描述', 'general', ctx.signal)
    expect(viaDeps.maxIterations).toBe(30)
    const explicit = makeSubagentOpts(makeDeps(), 'a-x', '描述', 'general', ctx.signal, undefined, undefined, undefined, null, 12)
    expect(explicit.maxIterations).toBe(12)
    // system getter：onIter 计数喂「当前第 N/M 轮」——LLM 实时自知轮数（2026-09-03 拍板）
    expect(typeof opts_system(explicit)).toBe('string')
    expect(opts_system(explicit)).toContain('第 0/12 轮')
    explicit.callbacks.onIter?.(5, 12)
    expect(opts_system(explicit)).toContain('第 5/12 轮')
  })
  it('onExhausted 挂进 callbacks（task 工具耗尽标注的数据通道）', () => {
    let fired = 0
    const opts = makeSubagentOpts(makeDeps(), 'a-x', '描述', 'general', ctx.signal, undefined, undefined, undefined, null, 10, () => {
      fired += 1
    })
    opts.callbacks.onExhausted?.(10)
    expect(fired).toBe(1)
  })
})

/** opts.system 求值（string | getter 统一——子代理为 getter 形态） */
function opts_system(opts: ReturnType<typeof makeSubagentOpts>): string {
  return typeof opts.system === 'function' ? opts.system() : opts.system
}

describe('makeTaskTool.execute（返回契约 + transcript）', () => {
  const transcriptDir = join(homedir(), '.ecode', 'agents')
  it('返回最后 assistant 文本；transcript 落盘', async () => {
    const deps = makeDeps()
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '查目录', prompt: '查 src 结构' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('结论：完成')
    // transcript 路径从返回值解析（agentId 唯一定位）——不扫目录猜「最新文件」：
    // 真实 agents 目录会被并行/历史用例同毫秒写入抢序（挂账「transcript 测试污染真实目录」读取侧收口）
    const m = /（完整过程：(.+\.jsonl)）/.exec(String(r.content))
    expect(m).not.toBeNull()
    // 返回文案是展示路径（~/ 字面量），实际落盘在（本测试已 mock 的）homedir 下
    const body = readFileSync((m?.[1] as string).replace(/^~/, homedir()), 'utf8')
    expect(body).toContain('查 src 结构')
  })

  it('2026-09-03：轮数耗尽标注返回值（task 入参钳 config 上限——999 钳到 2）', async () => {
    // 每轮 text+tool_use：跑满 maxIterations 后 lastAssistantText 非空 → 正常返回 +
    // 耗尽标注（父代理可分辨截断 vs 正常完成）；入参 999 只能往下钳到 config 2
    const round = [
      { type: 'text' as const, text: '部分结论' },
      { type: 'tool_use_start' as const, id: 't', name: 'read_file' },
      { type: 'tool_use_end' as const, id: 't' },
      { type: 'done' as const, stop_reason: 'tool_use' as const },
    ]
    const deps = makeDeps({
      getMaxIterations: () => 2,
      getProvider: () => new MockProvider([round, structuredClone(round)]),
    })
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '钳制探针', prompt: 'x', max_iterations: 999 }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('部分结论')
    expect(r.content).toContain('轮数耗尽 2/2')
    // 审阅修复批（安全席 P1-1）：标注与「完整过程：agents/<agentId>.jsonl」同行——agentId
    // 子代理不可知（system/meta 均不含），伪造者必须猜 id 才能逐字冒充标注
    expect(r.content).toMatch(/轮数耗尽 2\/2[^\n]*\.jsonl）/)
  })

  it('2026-09-03 审阅修复：并发子代理上限——宿主计数达 8 时新 task 立即拒绝（不跑 provider）', async () => {
    const deps = makeDeps()
    const tool = makeTaskTool(deps)
    const r = await tool.execute(
      { description: '超限探针', prompt: 'x' },
      { cwd: process.cwd(), signal: new AbortController().signal, session: { getActiveSubagentCount: () => 8 } },
    )
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('并发子代理已达上限')
  })

  it('F-46 运行期事件行逐条落盘（/output 运行期可见性）', async () => {
    const desc = `F46 运行期落盘探针 ${Date.now()}`
    let observed: string | null = null
    const probe: Tool = {
      name: 'probe',
      description: 'probe',
      input_schema: { type: 'object', properties: {} },
      readonly: true,
      async execute() {
        // 等 meta/tool_start 异步 append 完成（fire-and-forget 落盘）
        await new Promise((r) => setTimeout(r, 120))
        const dir = join(homedir(), '.ecode', 'agents')
        for (const f of existsSync(dir) ? readdirSync(dir) : []) {
          const p = join(dir, f)
          const body = readFileSync(p, 'utf8')
          if (body.includes(desc)) { observed = body; break }
        }
        return { content: 'ok' }
      },
    }
    const reg = new ToolRegistryImpl()
    reg.register(probe)
    const deps = makeDeps({
      registry: reg,
      getProvider: () => new MockProvider([
        [{ type: 'tool_use_start', id: 't1', name: 'probe' }, { type: 'tool_use_end', id: 't1' }, { type: 'done', stop_reason: 'tool_use' }],
        [{ type: 'text', text: '结论：完成' }, { type: 'done', stop_reason: 'end' }],
      ]),
    })
    const tool = makeTaskTool(deps)
    await tool.execute({ description: desc, prompt: 'x' }, ctx)
    // probe.execute 读到的快照：meta 与 tool_start 事件行已在（运行期可见）
    expect(observed, '工具执行中 transcript 应已含事件行').not.toBeNull()
    expect(observed).toContain('"kind":"meta"')
    expect(observed).toContain('"kind":"tool_start"')
    expect(observed).toContain('probe')
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

  it('用户中断快速返回（2026-08-29）：ctx.signal 已断 + 无临终遗言 → 即停即返，不再发起自总结 LLM 调用', async () => {
    let calls = 0
    const deps = makeDeps({
      getProvider: () => {
        calls++
        return new MockProvider([[{ type: 'done', stop_reason: 'end' }]]) // 内层 loop 无文本即终
      },
    })
    const ac = new AbortController()
    ac.abort()
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '调研', prompt: 'p' }, { cwd: process.cwd(), signal: ac.signal })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('被用户中断')
    expect(calls).toBe(1) // 只内层 loop 一次——resumeSummary 未再调 provider（Ctrl+C 不再假死 60s）
  })

  it('对照（B4 保留）：非中断的无产出（超时形态）仍走自总结抢救', async () => {
    let calls = 0
    const deps = makeDeps({
      getProvider: () => {
        calls++
        return new MockProvider([[{ type: 'done', stop_reason: 'end' }]])
      },
    })
    const tool = makeTaskTool(deps)
    const r = await tool.execute({ description: '调研', prompt: 'p' }, ctx) // ctx.signal 未断
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('未产出') // 自总结跑了但抢不出文本 → 未产出文案
    expect(calls).toBe(2) // 内层 loop + 自总结各一次
  })

  it('进度桥：setSubagentProgressHandler 收运行中快照（onToolStart 更新活动，结束移除）', async () => {
    const snaps: Array<Array<{ id: string; description: string; activity: string; waitingSince?: number }>> = []
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
    // 启动快照（activity=启动中）→ 工具活动快照 → LLM 等待期快照（思考中+打点）→ 结束空快照
    expect(snaps.some((l) => l.length === 1 && l[0].description === '调研' && l[0].activity === '启动中')).toBe(true)
    expect(snaps.some((l) => l.length === 1 && l[0].activity === 'read_file')).toBe(true)
    expect(snaps.some((l) => l.length === 1 && l[0].activity === '思考中' && typeof l[0].waitingSince === 'number')).toBe(true)
    expect(snaps.at(-1)).toEqual([])
  })

  it('2026-09-03 审阅修复批：同轮两个 task 真并行（并发计数哨兵——提示词「同轮多调用即并行」的子代理级锁）', async () => {
    // 机制锁：两个 task execute 并发发起（Promise.all 同款时序），执行中段观察到
    // 运行计数达 2——若并发被破坏（串行化/闸门误拒），maxSeen 停在 1 且本测试红
    let running = 0
    let maxSeen = 0
    const provider: LLMProvider = {
      type: 'mock',
      async *run(): AsyncIterable<Delta> {
        running++
        maxSeen = Math.max(maxSeen, running)
        await new Promise((r) => setTimeout(r, 80)) // 拉开中段观测窗
        running--
        yield { type: 'text', text: '结论：完成' }
        yield { type: 'done', stop_reason: 'end' }
      },
    }
    const deps = makeDeps({ getProvider: () => provider })
    const tool = makeTaskTool(deps)
    const rs = await Promise.all([
      tool.execute({ description: '甲', prompt: 'p1' }, ctx),
      tool.execute({ description: '乙', prompt: 'p2' }, ctx),
    ])
    expect(rs.every((r) => r.is_error !== true)).toBe(true)
    expect(maxSeen).toBe(2) // 两个子循环真并发（重叠窗口内同时 in-flight）
  })
})


describe('M11 审阅修复批：桥优先与 SubRegistry 视图', () => {
  it('P0-2/P1-1/P1-2：桥挂载时 onBeforeWrite/providerReq/sandbox/model 用桥现值，卸载回退 deps', () => {
    const wrote: Array<string[]> = []
    const sandboxFake = { checkWrite: () => undefined, checkBash: () => undefined }
    setSubagentBridge({
      confirm: async () => true,
      onBeforeWrite: async (paths) => {
        wrote.push(paths)
      },
      getProviderReq: () => ({ name: 'bridge', baseURL: 'http://b', apiKey: 'k', model: 'model-new' }),
      getSandbox: () => sandboxFake as never,
      getModel: () => 'm-bridge',
    })
    try {
      const deps = makeDeps()
      const opts = makeSubagentOpts(deps, 'a-b1', '桥测', 'general', ctx.signal)
      expect(opts.providerReq.model).toBe('model-new')
      expect(opts.toolCtx.model).toBe('m-bridge')
      expect(opts.toolCtx.sandbox).toBe(sandboxFake)
      void opts.toolCtx.onBeforeWrite?.(['/x'], 'edit_file')
      expect(wrote).toEqual([['/x']])
    } finally {
      setSubagentBridge(null)
    }
    // 回退 deps 静态值
    const deps2 = makeDeps()
    const opts2 = makeSubagentOpts(deps2, 'a-b2', '回退', 'general', ctx.signal)
    expect(opts2.providerReq.model).toBe('m')
    expect(opts2.toolCtx.sandbox).toBeUndefined()
  })

  it('P1-3：SubRegistry 是过滤视图——get 返回父表对象（hook 装饰保留），非重注册副本', () => {
    const parent = makeDeps().registry
    const sub = new SubRegistry(parent, 'general')
    const t = sub.get('read_file')
    expect(t).toBe(parent.get('read_file')) // 同一引用（父是 Hooked 时即包装版）
    expect(sub.get('task')).toBeUndefined()
    expect(sub.get('ask_user')).toBeUndefined()
    // explore 视图拒副作用工具
    const exp = new SubRegistry(parent, 'explore')
    expect(exp.get('bash')).toBeUndefined()
    expect(exp.get('read_file')).toBeDefined()
  })

  it('M14-C5②：桥挂 getSummaryRole 时 task execute 解析摘要角色（roles.summary 换笔通子代理压缩链）；未挂不炸', async () => {
    let asked = 0
    setSubagentBridge({
      confirm: async () => true,
      getSummaryRole: async () => {
        asked++
        return null // 值形态的换笔行为由主链 hook 测试覆盖；此处锁「子代理取到桥角色」的通路
      },
    })
    try {
      const deps = makeDeps()
      const tool = makeTaskTool(deps)
      const r = await tool.execute({ description: '换笔通路', prompt: '跑一句' }, ctx)
      expect(r.is_error).toBeFalsy()
      expect(asked).toBe(1) // execute 内解析过桥角色（传参进 makeSubagentOpts）
    } finally {
      setSubagentBridge(null)
    }
  })
})

describe('审阅修复批1 P0-3：运行态四 getter 会话端口优先（模块桥单槽不串台）', () => {
  it('sessPort 提供四 getter 时优先于模块桥（桥被别项目覆盖也不影响本会话）', async () => {
    setSubagentBridge({
      confirm: async () => true,
      // 模拟 B 项目覆盖桥：值与本项目（deps）都不同
      getProviderReq: () => ({ name: 'WRONG', baseURL: 'http://wrong', apiKey: 'k', model: 'wrong-model' }),
      getModel: () => 'wrong-model',
      getSummaryRole: async () => null,
    })
    try {
      const deps = makeDeps()
      const sessPort = {
        getProviderReq: () => ({ name: 'right', baseURL: 'http://right', apiKey: 'k', model: 'right-model' }),
        getModel: () => 'right-model',
        getSummaryRole: async () => null,
      }
      const opts = makeSubagentOpts(deps, 'a-p0', '端口优先', 'general', ctx.signal, undefined, undefined, sessPort)
      expect(opts.providerReq.model).toBe('right-model') // 端口胜出，不是桥的 wrong-model
      expect(opts.toolCtx.model).toBe('right-model')
      // 端口缺项时回退桥（兜底链仍通）
      const opts2 = makeSubagentOpts(deps, 'a-p0b', '回退', 'general', ctx.signal, undefined, undefined, {})
      expect(opts2.providerReq.model).toBe('wrong-model')
    } finally {
      setSubagentBridge(null)
    }
  })
})
