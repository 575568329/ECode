/**
 * /model 切换发宿主帧（2026-09-03 假切换根治的 TUI 侧行为锚，审阅补测）：
 * 附着态（fake TuiHost）pick-model → onPick 必须发 model/set 帧（provider+model 双参）；
 * 宿主拒绝 → 本地显示回滚 + sticky notice；连切乱序 → 落后回执被序号闸丢弃（不回滚）。
 * deps 真件形态照 SubmitEcho.test.tsx；host 为 fake（捕获 sent）。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import path from 'node:path'
import os from 'node:os'
import { TuiApp } from '../../src/tui/TuiApp.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'
import { LLMProviderRegistryImpl } from '../../src/providers/registry.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { SkillRegistry } from '../../src/services/skill.js'
import type { TuiHost } from '../../src/tui/types.js'
import type { ProtocolCommand, ProtocolEvent } from '../../src/protocol/types.js'
import type { CommandResult } from '../../src/protocol/channel.js'
import type { Config } from '../../src/services/config.js'
import type { Logger } from '../../src/services/logger.js'
import type { HistoryStore } from '../../src/services/history.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const config: Config = {
  providers: {
    astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'] },
    deepseek: { type: 'openai', baseURL: 'http://b', apiKey: 'k', models: ['deepseek-v4'] },
  },
  current: { name: 'astron', model: 'glm-5.2' },
  maxIterations: 50,
  bashMaxOutputBytes: 30720,
  logLevel: 'info',
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const noopHistory = {
  append() {},
  appendCompactBoundary() {},
  loadAll() { return [] },
  restore() { return [] },
  restoreFull() { return [] },
  setSessionId() {},
  currentSessionId() { return 'test-session' },
} as unknown as HistoryStore

function makeDeps() {
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  return {
    providerRegistry: new LLMProviderRegistryImpl(),
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: noopHistory,
    config: { ...config, providers: { ...config.providers }, current: { ...config.current } },
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-modelswitch-skills') }),
    mcpManager: null,
  }
}

/** fake host：捕获 sent；model/set 按 provider 名可控（延迟回执/失败） */
function makeHost(opts: { failModelSet?: boolean; delayProvider?: string } = {}) {
  const sent: ProtocolCommand[] = []
  const pending = new Map<string, (r: CommandResult) => void>()
  const host: TuiHost = {
    send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
      sent.push(cmd)
      if (cmd.op === 'model/set') {
        const p = (cmd as { provider: string }).provider
        if (opts.failModelSet) return { ok: false, error: `provider 不存在：${p}` }
        if (opts.delayProvider === p) {
          return new Promise((res) => { pending.set(p, res) })
        }
        return { ok: true }
      }
      if (cmd.op === 'session/new') return { ok: true, sessionId: 's-switch' }
      if (cmd.op === 'session/read') return { ok: true, value: [] }
      return { ok: true }
    },
    subscribe: (_h: (ev: ProtocolEvent) => void): (() => void) => () => {},
    dispose: () => {},
  }
  return { host, sent, pending }
}

/** /model 两段式打开 picker（统一补全+执行），再按需 ↓/回车选目标 */
async function openPicker(stdin: { write: (s: string) => void }): Promise<void> {
  stdin.write('/model')
  await flush()
  stdin.write('\r')
  await flush()
  stdin.write('\r') // 第二个回车=执行（统一两段式）
  await flush()
}

beforeEach(() => {
  commandRegistry.clear()
  registerBuiltinCommands()
})

afterEach(() => {
  cleanup()
  commandRegistry.clear()
  registerBuiltinCommands()
})

describe('TuiApp /model 发宿主帧（2026-09-03 假切换根治锚）', () => {
  it('选中 deepseek → 宿主收到 model/set 帧（provider+model 双参）', async () => {
    const { host, sent } = makeHost()
    const view = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    await openPicker(view.stdin)
    view.stdin.write('\u001b[B') // ↓ 选中第二项 deepseek-v4
    await flush()
    view.stdin.write('\r')
    await flush(80)
    const frame = sent.find((c) => c.op === 'model/set') as { op: 'model/set'; provider: string; model: string } | undefined
    expect(frame).toBeDefined()
    expect(frame).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4' })
    expect((view.lastFrame() ?? '')).toContain('deepseek-v4') // 显示已切
  })

  it('宿主拒绝（daemon 无此 provider）→ 本地显示回滚 + notice 提示', async () => {
    const { host } = makeHost({ failModelSet: true })
    const view = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    await openPicker(view.stdin)
    view.stdin.write('\u001b[B')
    await flush()
    view.stdin.write('\r')
    await flush(80)
    const f = view.lastFrame() ?? ''
    expect(f).toContain('切换未送达宿主')
    expect(f).toContain('provider 不存在')
    // 回滚：状态栏回 astron/glm-5.2（显示与宿主一致，不再「显示已切实际未切」）
    expect(f).toContain('glm-5.2')
    expect(f).not.toContain('deepseek-v4')
  })

  it('连切乱序：落后的失败回执被序号闸丢弃——不把最新意图回滚', async () => {
    const { host, pending } = makeHost({ delayProvider: 'astron' })
    const view = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    // 第一次：选 astron（第一项，model/set 挂起）
    await openPicker(view.stdin)
    view.stdin.write('\r')
    await flush()
    // 第二次：选 deepseek（成功）
    await openPicker(view.stdin)
    view.stdin.write('\u001b[B')
    await flush()
    view.stdin.write('\r')
    await flush(80)
    // 放行 astron 的迟到失败回执
    pending.get('astron')?.({ ok: false, error: 'provider 不存在：astron' })
    await flush(80)
    const f = view.lastFrame() ?? ''
    expect(f).not.toContain('切换未送达宿主') // 落后回执静默丢弃
    expect(f).toContain('deepseek-v4') // 未被回滚
  })
})
