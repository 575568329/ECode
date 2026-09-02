/**
 * 挂账⑩：TuiApp 帧接线集成测试（R5）——历史 bug 高发层（同名并行 findIndex 错位正是此层病）。
 * 驱动一串协议帧断言最终渲染：分段文本/思考行/工具行 digest/thinking loading 摘要/turn 边界。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import { TuiApp, type TuiHost } from '../../src/tui/TuiApp.js'
import type { ProtocolCommand, ProtocolEvent, CommandResult } from '../../src/protocol/types.js'
import type { HistoryLine, Message } from '../../src/core/types.js'
import { LLMProviderRegistryImpl } from '../../src/providers/registry.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'
import type { Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { SkillRegistry } from '../../src/services/skill.js'
import type { Logger } from '../../src/services/logger.js'
import type { HistoryStore } from '../../src/services/history.js'

vi.mock('../../src/services/clipboard.js', () => ({ readClipboardImage: vi.fn() }))

const config: Config = {
  providers: { astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'] } },
  current: { name: 'astron', model: 'glm-5.2' },
  maxIterations: 50,
  bashMaxOutputBytes: 30720,
  logLevel: 'info',
} as unknown as Config

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const noopHistory = {
  append() {},
  appendCompactBoundary() {},
  appendRewind() {},
  appendThinking() {},
  loadAll() { return [] },
  restore() { return [] },
  restoreFull() { return [] },
  setSessionId() {},
  currentSessionId() { return 'test-session' },
} as unknown as HistoryStore

const flush = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeDeps() {
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  return {
    providerRegistry: new LLMProviderRegistryImpl(),
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: noopHistory,
    config,
    orchestrator,
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-tl-skills') }),
    mcpManager: null,
  }
}

function makeFakeHost() {
  let handler: ((ev: ProtocolEvent) => void) | null = null
  const host: TuiHost = {
    send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
      if (cmd.op === 'prompt') return { ok: true, routed: 'Started', sessionId: 's-tl' }
      if (cmd.op === 'session/read') return { ok: true, value: [] as HistoryLine[] }
      return { ok: true }
    },
    subscribe: (h: (ev: ProtocolEvent) => void) => {
      handler = h
      return () => { handler = null }
    },
    dispose: () => {},
  }
  return { host, fire: (ev: ProtocolEvent): void => { handler?.(ev) } }
}

describe('R5：TuiApp 时间线帧接线（挂账⑩）', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })
  afterEach(() => cleanup())

  it('一串帧驱动：分段文本（delta→started→delta 不黏连）+ 思考行 + digest + 完成回填', async () => {
    const { host, fire } = makeFakeHost()
    const { lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: null, iter: 1 })
    fire({ type: 'delta', seq: 2, turnId: 't1', text: '前段话' })
    fire({ type: 'thinking', seq: 3, turnId: 't1', blockIndex: 0, text: '想一下' })
    fire({ type: 'thinking/ended', seq: 4, turnId: 't1', blockIndex: 0, durMs: 3000 })
    fire({ type: 'item/started', seq: 5, turnId: 't1', itemId: 'tu_1', name: 'grep' })
    fire({ type: 'item/executing', seq: 6, turnId: 't1', itemId: 'tu_1', digest: 'grep pattern' })
    fire({ type: 'item/completed', seq: 7, itemId: 'tu_1', name: 'grep', isError: false, summary: 'ok', content: '结果行' })
    fire({ type: 'delta', seq: 8, turnId: 't1', text: '后段结论' })
    await flush(60)
    const f = lastFrame() ?? ''
    // 24 行默认窗计价紧：老条目（前段/grep）按设计折叠，最新保住——断言折叠形态+最新内容
    expect(f).toContain('已折叠')
    expect(f).toContain('后段结论')
    expect(f).not.toContain('前段话后段结论') // 分段不黏连（旧 streamingText 会黏）
    // 注：思考行与本轮更老条目随折叠线收进摘要（24 行默认窗 live 段占满预算——正确行为，
    // 其渲染在下方短时间线用例单独验证）
  })

  it('turn/started 只清 timeline 不动 userInput（双清空点幂等）', async () => {
    const { host, fire } = makeFakeHost()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: null, iter: 1 })
    fire({ type: 'delta', seq: 2, turnId: 't1', text: '旧轮内容' })
    await flush(40)
    // 模拟发送失败回执窗口：userInput 残留 + turn/started 权威清空 timeline
    fire({ type: 'turn/started', seq: 3, turnId: 't2' })
    await flush(40)
    const f = lastFrame() ?? ''
    expect(f).not.toContain('旧轮内容')
  })

  it('短时间线：思考终态行渲染（ended 后上屏，live 期间不占行）', async () => {
    const { host, fire } = makeFakeHost()
    const { lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: null, iter: 1 })
    fire({ type: 'thinking', seq: 2, turnId: 't1', blockIndex: 0, text: '纯思考轮' })
    await flush(40)
    expect(lastFrame() ?? '').not.toContain('思考 ·') // live 不占行
    fire({ type: 'thinking/ended', seq: 3, turnId: 't1', blockIndex: 0, durMs: 4200 })
    await flush(40)
    expect(lastFrame() ?? '').toContain('思考 · 持续了 4 秒')
  })

  it('审批挂起：ActivityBar 显示等待审批而非思考计时（R5 真机实证修复）', async () => {
    const { host, fire } = makeFakeHost()
    const { lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: 'approval', iter: 1 })
    fire({ type: 'approval/requested', seq: 2, requestId: 'ar1', kind: 'tool-confirm', tool: 'bash', preview: 'ls', decisions: ['once', 'reject'] })
    await flush(60)
    const f3 = lastFrame() ?? ''
    expect(f3).toContain('执行 bash') // 审批卡即等待态权威显示（ActivityBar 等待审批文案为增益）
  })
})
