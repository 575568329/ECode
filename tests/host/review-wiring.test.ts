/**
 * 任务纠偏审查接线（2026-09-02 用户拍板）：HostSession 两个触发点的端到端。
 * ① 定时兜底：第 5 轮末触发审查 → 空闲完成 → pendingReviewCard → 第 6 轮 input 携带卡（不自动起轮）；
 * ② 异常信号：单轮连续 2 个工具失败 → afterTools 提前触发 → 卡注入（轮末队列续投消化）；
 * ③ 开关：enabled=false / 不配 → 零审查调用（行为零变化）。
 * Provider 按 req.model 分流：主模型走脚本序列，reviewer 模型走独立脚本（真实形态=不同模型不同请求）。
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

/** 按 model 分流（主循环与审查共用 registry.getByType——同 type 单 provider，靠 req.model 区分） */
class ModelRoutingProvider implements LLMProvider {
  readonly type = 'mock'
  private mainCall = 0
  private reviewCall = 0
  /** 审查调用计数（断言触发次数） */
  public reviewCalls = 0
  /** 审查调用收到的 messages（断言上下文） */
  public reviewMessages: Message[][] = []
  constructor(
    private readonly mainScript: Delta[][],
    private readonly reviewScript: Delta[][],
  ) {}
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    if (req.model === REVIEW_MODEL) {
      this.reviewCalls += 1
      this.reviewMessages.push((req.messages ?? []) as Message[])
      const deltas = this.reviewScript[this.reviewCall++] ?? [{ type: 'done', stop_reason: 'end' }]
      for (const d of deltas) yield d
      return
    }
    const deltas = this.mainScript[this.mainCall++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
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

function makeDeps(provider: LLMProvider, review?: Config['review']): { deps: HostDeps; config: Config } {
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
  const deps: HostDeps = {
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore() as HistoryStore,
    getConfig: () => config,
    orchestrator,
    // 必传：缺了 startTurn 在 buildSystemPrompt(deps.skillListForPrompt()) 处 TypeError 早退
    // ——每轮 catch→finishTurn，messages 恒 0（排查实录：审查收到 0 条上下文的真因）
    skillListForPrompt: () => [],
    cwd: process.cwd(),
  }
  return { deps, config }
}

const doneDelta: Delta = { type: 'done', stop_reason: 'end' }
const flush = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('任务纠偏审查：HostSession 接线', () => {
  it('① 定时兜底：第 5 轮末触发审查（第 3/4 轮不触发）；空闲完成暂存，第 6 轮 input 携带卡', async () => {
    // 6 轮主脚本：每轮一条 done（纯文本轮——信号不触发，纯测定时）
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
    expect(p.reviewCalls).toBe(1) // 恰第 5 轮末一次
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('已请高级模型审查（第 5 轮定时'))).toBe(true)
    // 空闲完成 → 暂存（不自动起轮——无新 provider 调用）
    const callsAfterIdle = p.reviewCalls
    await flush()
    expect(p.reviewCalls).toBe(callsAfterIdle)
    // 第 6 轮：input 携带卡（注入文本进入审查视角之外的断言面：主模型收到含卡 user）
    await host.send({ op: 'prompt', text: '第6轮', mode: 'StartOrSteer' })
    await host.whenIdle()
    // 审查上下文断言：第 5 轮触发时看到此前 5 轮对话（尾部窗口内）
    expect(p.reviewMessages.length).toBe(1)
    const seen = JSON.stringify(p.reviewMessages[0])
    expect(seen).toContain('第5轮')
    // 卡经 pendingReviewCard 拼进第 6 轮 input → 落进 messages（transcript 可审计）
    const transcript = JSON.stringify((host as unknown as { messages: Message[] }).messages)
    expect(transcript).toContain('[纠偏审查——高级模型对任务方向与执行质量的审查')
    expect(transcript).toContain('- 方向：正确')
    host.dispose()
  }, 15_000)

  it('② 异常信号：单轮连续 2 个工具失败 → 提前触发（不等第 5 轮）；卡注入模型输入', async () => {
    // 轮 1：assistant 一批两个 fail 工具调用（readonly 并行）→ afterTools 连续失败段=2 → 信号触发；
    // 轮 2（轮末队列续投消化卡）：done
    const toolUse = (id: string): Delta[] => [
      { type: 'tool_use_start', id, name: 'fail' },
      { type: 'tool_use_end', id },
    ]
    const p = new ModelRoutingProvider(
      [
        [...toolUse('t1'), ...toolUse('t2'), { type: 'done', stop_reason: 'tool_use' }],
        [doneDelta],
      ],
      [[{ type: 'text', text: REVIEW_CARD }, { type: 'usage', input_tokens: 100, output_tokens: 20 }, doneDelta]],
    )
    const { deps } = makeDeps(p, { enabled: true, provider: 'm', model: REVIEW_MODEL, intervalTurns: 99 }) // 定时调大——纯测信号
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: '跑失败工具', mode: 'StartOrSteer' })
    await host.whenIdle()
    await flush()
    expect(p.reviewCalls).toBe(1) // 第 1 轮即触发（interval=99 证明非定时路径）
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('异常信号'))).toBe(true)
    // mock 轮瞬时结束：审查完成时轮已收 → 卡走 pendingReviewCard 分支（不自动起轮烧 token）——
    // 真实长轮（12+ 迭代）里审查完成时轮仍在跑，则走 midTurn 插话注入当前轮（设计双分支）。
    // 此处验证 pending 分支：下一轮 prompt 携带卡进 transcript
    await host.send({ op: 'prompt', text: '继续', mode: 'StartOrSteer' })
    await host.whenIdle()
    const transcript = JSON.stringify((host as unknown as { messages: Message[] }).messages)
    expect(transcript).toContain('- 方向：正确')
    expect(transcript).toContain('纠偏审查')
    host.dispose()
  }, 15_000)

  it('③ 开关：enabled=false → 5 轮 + 连续失败均零审查调用（行为零变化）', async () => {
    const toolUse = (id: string): Delta => ({ type: 'tool_use', id, name: 'fail', input: {} })
    const p = new ModelRoutingProvider([[toolUse('t1'), toolUse('t2'), doneDelta]], [])
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

    // 不配 review 块同款（默认零行为）
    const p2 = new ModelRoutingProvider([[doneDelta]], [])
    const { deps: deps2 } = makeDeps(p2)
    const host2 = new HostSession(deps2)
    await host2.send({ op: 'prompt', text: 'x', mode: 'StartOrSteer' })
    await host2.whenIdle()
    expect(p2.reviewCalls).toBe(0)
    host2.dispose()
  }, 15_000)
})
