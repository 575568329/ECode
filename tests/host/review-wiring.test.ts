/**
 * 任务纠偏审查接线（2026-09-02 用户拍板）+ 四角色审阅修复批回归。
 * 覆盖：
 * ① 定时兜底：第 5 轮末恰一次（含 hook-block 防重）、下轮 input 携带卡（中性前缀）；
 * ② 异常信号：连续失败提前触发 + pending 注入；
 * ③ 开关零行为；
 * ④ midTurn 注入分支（gate 挂起审查制造同轮窗口——kind:'review' 中性包装不冒充用户）；
 * ⑤ 旁路记账（stats 按 reviewer 模型落盘、不发 usage 帧）；
 * ⑥ 信号每轮一次（连续多批失败只审一次）；
 * ⑦ restoreFrom 归零；
 * ⑧ 审查失败静默降级；
 * ⑨ hook block 轮不重复触发定时。
 * Provider 按 req.model 分流；gate 数组可挂起指定调用（制造时序窗口）。
 */
import { describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, Message } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore, type HistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

const REVIEW_MODEL = 'glm-reviewer'

/** 按 model 分流（主循环与审查共用 registry.getByType——同 type 单 provider，靠 req.model 区分）。
 *  gate：第 n 次主/审查调用吐首个 delta 前挂起的 Promise（制造时序窗口）。 */
class ModelRoutingProvider implements LLMProvider {
  readonly type = 'mock'
  private mainCall = 0
  private reviewCall = 0
  public reviewCalls = 0
  public reviewMessages: Message[][] = []
  /** 主模型每次调用收到的 messages（断言注入文本用） */
  public mainMessages: Message[][] = []
  constructor(
    private readonly mainScript: Delta[][],
    private readonly reviewScript: Delta[][],
    private readonly mainGates: Array<Promise<void> | undefined> = [],
    private readonly reviewGates: Array<Promise<void> | undefined> = [],
  ) {}
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    if (req.model === REVIEW_MODEL) {
      const gate = this.reviewGates[this.reviewCall]
      this.reviewCalls += 1
      this.reviewMessages.push((req.messages ?? []) as Message[])
      const deltas = this.reviewScript[this.reviewCall++] ?? [{ type: 'done', stop_reason: 'end' }]
      for (const d of deltas) {
        if (gate !== undefined) await gate
        yield d
      }
      return
    }
    const gate = this.mainGates[this.mainCall]
    this.mainMessages.push((req.messages ?? []) as Message[])
    const deltas = this.mainScript[this.mainCall++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) {
      if (gate !== undefined) await gate
      yield d
    }
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const okTool: Tool = {
  name: 'ok',
  description: 'ok',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  async execute() {
    return { content: 'ok' }
  },
}
const failTool: Tool = {
  name: 'fail',
  description: 'always fails',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  async execute() {
    throw new Error('boom')
  },
}

const REVIEW_CARD = '[纠偏审查]\n- 方向：正确\n- 下一步：继续完成剩余测试'

interface SpyHistory extends HistoryStore {
  statsRecords: Array<{ model: string; input: number; output: number }>
}
function makeHistory(): SpyHistory {
  const base = new NoopHistoryStore() as HistoryStore & Record<string, unknown>
  const statsRecords: SpyHistory['statsRecords'] = []
  base.appendUsageStats = (r: { model: string; input: number; output: number }) => {
    statsRecords.push({ model: r.model, input: r.input, output: r.output })
  }
  return Object.assign(base, { statsRecords }) as SpyHistory
}

function makeDeps(
  provider: LLMProvider,
  review?: Config['review'],
  hookRunner?: HostDeps['hookRunner'],
): { deps: HostDeps; history: SpyHistory } {
  const reg = new ToolRegistryImpl()
  reg.register(okTool)
  reg.register(failTool)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: {
      m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m', REVIEW_MODEL], contextWindow: 32000 },
    },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
    ...(review !== undefined ? { review } : {}),
  }
  const history = makeHistory()
  const deps: HostDeps = {
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history,
    getConfig: () => config,
    orchestrator,
    // 必传：缺了 startTurn 在 buildSystemPrompt(deps.skillListForPrompt()) 处 TypeError 早退
    // ——每轮 catch→finishTurn，messages 恒 0（排查实录：审查收到 0 条上下文的真因）
    skillListForPrompt: () => [],
    cwd: process.cwd(),
    ...(hookRunner !== undefined ? { hookRunner } : {}),
  }
  return { deps, history }
}

const doneDelta: Delta = { type: 'done', stop_reason: 'end' }
const failToolUses = (id: string): Delta[] => [
  { type: 'tool_use_start', id, name: 'fail' },
  { type: 'tool_use_end', id },
]
const flush = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))
const hostMessages = (host: HostSession): Message[] => (host as unknown as { messages: Message[] }).messages

describe('任务纠偏审查：HostSession 接线（含审阅修复批）', () => {
  it('① 定时兜底：第 5 轮末恰一次；下轮 input 单消息携带卡（中性前缀，单消息双锚）', async () => {
    const p = new ModelRoutingProvider([[doneDelta], [doneDelta], [doneDelta], [doneDelta], [doneDelta], [doneDelta]], [
      [{ type: 'text', text: REVIEW_CARD }, doneDelta],
    ])
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL })
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    for (let i = 1; i <= 5; i++) {
      await host.send({ op: 'prompt', text: `第${i}轮`, mode: 'StartOrSteer' })
      await host.whenIdle()
      await flush() // 审查异步链（第 5 轮触发）
    }
    expect(p.reviewCalls).toBe(1)
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('已请高级模型审查（第 5 轮定时'))).toBe(true)
    await host.send({ op: 'prompt', text: '第6轮', mode: 'StartOrSteer' })
    await host.whenIdle()
    // 审查上下文方向锚（测试席质量项）：看到第 5 轮、看不到第 6 轮（触发点在轮末终局）
    const seen = JSON.stringify(p.reviewMessages[0])
    expect(seen).toContain('第5轮')
    expect(seen).not.toContain('第6轮')
    // 卡去向单消息双锚（测试席 P1）：最后一条 user 消息内同时含第 6 轮文本与中性审查前缀
    const lastUser = [...hostMessages(host)].reverse().find((m) => m.role === 'user')
    const lastUserText = JSON.stringify(lastUser)
    expect(lastUserText).toContain('第6轮')
    expect(lastUserText).toContain('审查器附注')
    expect(lastUserText).toContain('- 方向：正确')
    // 内层 [纠偏审查] 标头已剥（防双层）
    expect(lastUserText).not.toContain('[纠偏审查]\\n- 方向')
    host.dispose()
  }, 15_000)

  it('② 异常信号：连续失败提前触发（interval=99 证明非定时）；pending 注入下一轮', async () => {
    const p = new ModelRoutingProvider(
      [[...failToolUses('t1'), ...failToolUses('t2'), { type: 'done', stop_reason: 'tool_use' }], [doneDelta]],
      [[{ type: 'text', text: REVIEW_CARD }, { type: 'usage', input_tokens: 100, output_tokens: 20 }, doneDelta]],
    )
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL, intervalTurns: 99 })
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: '跑失败工具', mode: 'StartOrSteer' })
    await host.whenIdle()
    await flush()
    expect(p.reviewCalls).toBe(1)
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('异常信号'))).toBe(true)
    await host.send({ op: 'prompt', text: '继续', mode: 'StartOrSteer' })
    await host.whenIdle()
    const lastUser = [...hostMessages(host)].reverse().find((m) => m.role === 'user')
    const t = JSON.stringify(lastUser)
    expect(t).toContain('继续')
    expect(t).toContain('审查器附注')
    host.dispose()
  }, 15_000)

  it('③ 开关：enabled=false 与不配 → 零审查调用（行为零变化）', async () => {
    const p = new ModelRoutingProvider([[...failToolUses('t1'), ...failToolUses('t2'), { type: 'done', stop_reason: 'tool_use' }]], [])
    const { deps } = makeDeps(p, { enabled: false, provider: 'm', model: REVIEW_MODEL })
    const host = new HostSession(deps)
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    for (let i = 0; i < 5; i++) {
      await host.send({ op: 'prompt', text: `第${i}轮`, mode: 'StartOrSteer' })
      await host.whenIdle()
    }
    await flush()
    expect(p.reviewCalls).toBe(0)
    host.dispose()

    const p2 = new ModelRoutingProvider([[doneDelta]], [])
    const { deps: deps2 } = makeDeps(p2)
    const host2 = new HostSession(deps2)
    await host2.send({ op: 'prompt', text: 'x', mode: 'StartOrSteer' })
    await host2.whenIdle()
    expect(p2.reviewCalls).toBe(0)
    host2.dispose()
  }, 15_000)

  it('④ midTurn 注入（审阅修复回归）：审查完成时同轮仍在跑 → kind:review 插话（中性包装，不冒充用户）', async () => {
    // 双 gate 构造同轮窗口：iter1 fail×2（触发信号，审查挂起）→ iter2 挂起（主轮在跑）→
    // 放开审查（同轮完成→midTurn 入队）→ 放开主轮 → iter3 pollUserInput 注入
    const gMain = Promise.withResolvers<void>()
    const gReview = Promise.withResolvers<void>()
    const okToolUses = (id: string): Delta[] => [
      { type: 'tool_use_start', id, name: 'ok' },
      { type: 'tool_use_end', id },
    ]
    const p = new ModelRoutingProvider(
      [
        [...failToolUses('t1'), ...failToolUses('t2'), { type: 'done', stop_reason: 'tool_use' }], // iter1：触发信号
        [...okToolUses('t3'), { type: 'done', stop_reason: 'tool_use' }], // iter2：挂起（主轮仍在跑）
        [{ type: 'text', text: '收到建议' }, doneDelta], // iter3：收尾（注入已发生在迭代顶部）
      ],
      [[{ type: 'text', text: REVIEW_CARD }, doneDelta]],
      [undefined, gMain.promise],
      [gReview.promise],
    )
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL, intervalTurns: 99 })
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await flush(60) // iter1 完成（信号触发，审查挂在 gate）；iter2 调用挂起
    gReview.resolve() // 审查同轮完成 → midTurn 入队
    await flush(60)
    gMain.resolve() // iter2 继续 → iter3 顶部 pollUserInput 注入
    await host.whenIdle()
    await flush()
    expect(p.reviewCalls).toBe(1)
    expect(events.some((e) => e.type === 'interjection/injected' && e.text === '纠偏审查卡')).toBe(true)
    // iter3 主调用收到的 messages 含审查包装（中性，不冒充用户）
    const thirdCallMsgs = JSON.stringify(p.mainMessages[2])
    expect(thirdCallMsgs).toContain('审查器附注')
    expect(thirdCallMsgs).toContain('- 方向：正确')
    expect(thirdCallMsgs).not.toContain('用户在任务执行中发来新消息')
    expect(thirdCallMsgs).toContain('非用户消息')
    host.dispose()
  }, 15_000)

  it('⑤ 旁路记账：stats 按 reviewer 模型落盘；不发 usage 帧（不污染主轮口径）', async () => {
    const p = new ModelRoutingProvider(
      [[...failToolUses('t1'), ...failToolUses('t2'), { type: 'done', stop_reason: 'tool_use' }], [{ type: 'usage', input_tokens: 10, output_tokens: 5 }, doneDelta]],
      [[{ type: 'text', text: REVIEW_CARD }, { type: 'usage', input_tokens: 100, output_tokens: 20 }, doneDelta]],
    )
    const { deps, history } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL, intervalTurns: 99 })
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    await flush()
    const reviewerStats = history.statsRecords.find((r) => r.model === REVIEW_MODEL)
    expect(reviewerStats).toMatchObject({ input: 100, output: 20 })
    expect(history.statsRecords.filter((r) => r.model === 'm').length).toBeGreaterThanOrEqual(1) // 主轮照常记账
    // 审查调用不发 usage 帧（主轮帧的 contextUsed 不被审查覆盖——帧序里最后的 usage 帧属于主轮）
    const usageFrames = events.filter((e) => e.type === 'usage')
    for (const f of usageFrames) expect((f as { input: number }).input).not.toBe(100)
    host.dispose()
  }, 15_000)

  it('⑥ 信号每轮一次（审阅修复回归）：连续多批失败只审一次', async () => {
    // 三个 fail 批（批批命中连续失败信号）——reviewSignalFiredThisTurn 挡住后续
    const p = new ModelRoutingProvider(
      [
        [...failToolUses('t1'), ...failToolUses('t2'), { type: 'done', stop_reason: 'tool_use' }],
        [...failToolUses('t3'), ...failToolUses('t4'), { type: 'done', stop_reason: 'tool_use' }],
        [doneDelta],
      ],
      [[{ type: 'text', text: REVIEW_CARD }, doneDelta]],
    )
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL, intervalTurns: 99 })
    const host = new HostSession(deps)
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    await flush()
    expect(p.reviewCalls).toBe(1) // 不随批数增长
    host.dispose()
  }, 15_000)

  it('⑦ restoreFrom 归零：恢复后轮计数重数（4 历史轮 + 4 新轮 → 零触发）', async () => {
    const p = new ModelRoutingProvider(Array.from({ length: 8 }, () => [doneDelta]), [])
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL })
    const host = new HostSession(deps)
    for (let i = 0; i < 4; i++) {
      await host.send({ op: 'prompt', text: `旧${i}`, mode: 'StartOrSteer' })
      await host.whenIdle()
    }
    host.restoreFrom([{ role: 'user', content: [{ type: 'text', text: '恢复的会话' }] }])
    for (let i = 0; i < 4; i++) {
      await host.send({ op: 'prompt', text: `新${i}`, mode: 'StartOrSteer' })
      await host.whenIdle()
      await flush()
    }
    expect(p.reviewCalls).toBe(0) // 计数从恢复后重数（4 < minTurns 或非整除——第 5 轮才触发）
    host.dispose()
  }, 15_000)

  it('⑧ 审查失败静默降级：error delta → 提示「任务不受影响」，后续轮照常且可再触发', async () => {
    // 轮1=[fail批, 收尾]；轮2=[fail批, 收尾]——审查脚本第一次 error、第二次成功
    const p = new ModelRoutingProvider(
      [
        [...failToolUses('t1'), ...failToolUses('t2'), { type: 'done', stop_reason: 'tool_use' }],
        [doneDelta],
        [...failToolUses('t5'), ...failToolUses('t6'), { type: 'done', stop_reason: 'tool_use' }],
        [doneDelta],
      ],
      [
        [{ type: 'error', error: { message: '审查端点 500' } } as unknown as Delta],
        [{ type: 'text', text: REVIEW_CARD }, doneDelta],
      ],
    )
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL, intervalTurns: 99 })
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    await flush()
    expect(p.reviewCalls).toBe(1)
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('任务不受影响'))).toBe(true)
    // 下一轮（新轮重置 firedThisTurn）信号可再触发且成功
    await host.send({ op: 'prompt', text: '再跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    await flush()
    expect(p.reviewCalls).toBe(2)
    host.dispose()
  }, 15_000)

  it('⑨ hook block 轮不重复触发定时（审阅修复回归：lastIntervalReviewedTurn 防重）', async () => {
    const p = new ModelRoutingProvider([[doneDelta], [doneDelta], [doneDelta], [doneDelta], [doneDelta]], [
      [{ type: 'text', text: REVIEW_CARD }, doneDelta],
    ])
    const blockRunner = {
      hasHandlers: (ev: string) => ev === 'UserPromptSubmit',
      // 只拦「被拦的输入」——前 5 轮正常跑（计数推进），block 轮不重复触发是本用例靶点
      dispatch: async (_ev: string, payload: unknown) => ({ block: (payload as { prompt?: string }).prompt === '被拦的输入', additionalContext: [] }),
    } as unknown as HostDeps['hookRunner']
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL }, blockRunner)
    const host = new HostSession(deps)
    for (let i = 1; i <= 5; i++) {
      await host.send({ op: 'prompt', text: `第${i}轮`, mode: 'StartOrSteer' })
      await host.whenIdle()
      await flush()
    }
    expect(p.reviewCalls).toBe(1) // 第 5 轮末一次
    // 第 6 条输入被 hook block：block 早退（计数不自增）→ finishTurn 不得用旧值 5 再触发
    await host.send({ op: 'prompt', text: '被拦的输入', mode: 'StartOrSteer' })
    await flush()
    await host.send({ op: 'prompt', text: '又被拦', mode: 'StartOrSteer' })
    await flush()
    expect(p.reviewCalls).toBe(1)
    host.dispose()
  }, 15_000)
})
