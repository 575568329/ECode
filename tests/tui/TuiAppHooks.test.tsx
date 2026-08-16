/**
 * TuiApp hooks 事件接入测（H-P4）：mock HookRunner 断言事件时序与 UI 反馈。
 * 不驱动 runLoop（submit 的 UserPromptSubmit block 路径不进 runLoop，直接可断）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import { TuiApp } from '../../src/tui/TuiApp.js'
import { LLMProviderRegistryImpl } from '../../src/providers/registry.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { registerBuiltinCommands } from '../../src/commands/registry.js'
import { emptyShellConfig } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { SkillRegistry } from '../../src/services/skill.js'
import type { Logger } from '../../src/services/logger.js'
import type { HistoryStore } from '../../src/services/history.js'
import type { HookRunner } from '../../src/services/hooks/runner.js'
import type { HookVerdict } from '../../src/services/hooks/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'

const config = {
  providers: {
    // contextWindow 覆盖：resolveContextWindow 走 configOverride 直返，不触发 models.dev 联网（环境敏感）
    astron: { type: 'anthropic' as const, baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'], contextWindow: 200_000 },
  },
  current: { name: 'astron', model: 'glm-5.2' },
  maxIterations: 50,
  bashMaxOutputBytes: 30720,
  logLevel: 'info' as const,
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const noopHistory = {
  append() {},
  appendCompactBoundary() {},
  loadAll() { return [] },
  restore() { return [] },
  restoreFull() { return [] },
  setSessionId() {},
} as unknown as HistoryStore

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 60))

const noVerdict: HookVerdict = { block: false, additionalContext: [], systemMessages: [] }

function makeHookRunner(verdictFor: (event: string) => HookVerdict) {
  const dispatch = vi.fn(async (event: string) => verdictFor(event))
  const hasHandlers = vi.fn(() => true)
  return { dispatch, hasHandlers } as unknown as HookRunner
}

/** 空 Delta 流的 stub provider（runLoop 正常走完一轮，不发网络）。 */
const stubProvider: LLMProvider = {
  type: 'anthropic',
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    // 空流：无 assistant 回复，loop 一步结束（Stop 在 finally 触发）
  },
}

/** 挂起的 stub provider（等待中断）：监听 req.signal，aborted 时抛 AbortError——对齐真 SDK 行为。 */
function makeHangingProvider(): LLMProvider {
  return {
    type: 'anthropic',
    async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
      await new Promise<never>((_, reject) => {
        req.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    },
  }
}

function makeDeps(hookRunner: HookRunner | null, provider: LLMProvider = stubProvider) {
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const providerRegistry = new LLMProviderRegistryImpl()
  providerRegistry.register(provider)
  return {
    providerRegistry,
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: noopHistory,
    config,
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-tui-hooks-test') }),
    mcpManager: null,
    hookRunner,
  }
}

describe('TuiApp hooks 事件（H-P4）', () => {
  beforeEach(() => {
    registerBuiltinCommands()
  })

  it('挂载触发 SessionStart(startup)', async () => {
    const runner = makeHookRunner(() => noVerdict)
    render(React.createElement(TuiApp, { deps: makeDeps(runner) }))
    await flush()
    expect((runner as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch).toHaveBeenCalledWith(
      'SessionStart',
      expect.objectContaining({ source: 'startup' }),
    )
  })

  it('submit 触发 UserPromptSubmit；block → 不进 runLoop + 底部提示', async () => {
    const runner = makeHookRunner((event) =>
      event === 'UserPromptSubmit' ? { ...noVerdict, block: true, reason: '维护中' } : noVerdict,
    )
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(runner) }))
    await flush()
    stdin.write('hello')
    await flush()
    stdin.write('\r')
    await flush()
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('维护中')
    // block 后输入框可用（未被锁死），无错误 banner
    expect(f).not.toContain('Error')
  })

  it('UserPromptSubmit additionalContext → 拼接进消息（display 仍显示原文）', async () => {
    const runner = makeHookRunner((event) =>
      event === 'UserPromptSubmit' ? { ...noVerdict, additionalContext: ['team-style-guide: 简洁'] } : noVerdict,
    )
    const { stdin } = render(React.createElement(TuiApp, { deps: makeDeps(runner) }))
    await flush()
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    // 不驱动真 LLM——只断 dispatch 收到 prompt 原文（拼接发生在其后；M9-P0 起第三参透传 signal）
    expect((runner as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch).toHaveBeenCalledWith(
      'UserPromptSubmit',
      expect.objectContaining({ prompt: 'hi' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('submit 完成后触发 Stop（finally 路径）', async () => {
    const runner = makeHookRunner(() => noVerdict)
    const { stdin } = render(React.createElement(TuiApp, { deps: makeDeps(runner) }))
    await flush()
    stdin.write('hi')
    await flush()
    await flush()
    stdin.write('\r')
    await flush()
    // stub provider 空 Delta 流：runLoop 正常走完，Stop 在 finally 触发（异步链，轮询等待）
    await vi.waitFor(() => {
      expect((runner as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch).toHaveBeenCalledWith(
        'Stop',
        expect.objectContaining({ stop_reason: 'turn-complete' }),
      )
    })
  })

  it('hookRunner 为 null → 零 hooks 路径不炸', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(null) }))
    await flush()
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toBeTruthy()
  })

  // —— M9-P0 接线修复 ——

  it('SessionStart additionalContext → 注入恢复后首轮 user 消息（[hook context] 同款格式）', async () => {
    const runner = makeHookRunner((event) =>
      event === 'SessionStart' ? { ...noVerdict, additionalContext: ['env: node22', 'cwd: tmp'] } : noVerdict,
    )
    const append = vi.fn()
    const deps = { ...makeDeps(runner), history: { ...noopHistory, append } as unknown as HistoryStore }
    const { stdin } = render(React.createElement(TuiApp, { deps }))
    await flush()
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    await flush()
    const injected = append.mock.calls.some((c) => {
      const s = JSON.stringify(c[0])
      return s.includes('[hook context]') && s.includes('env: node22') && s.includes('cwd: tmp')
    })
    expect(injected).toBe(true)
  })

  it('中断路径 Stop stop_reason=aborted（正常完成仍 turn-complete）', async () => {
    // provider 挂起等待中断；Ctrl+C abort → catch(isAbortError) → finally Stop(aborted)
    const runner = makeHookRunner(() => noVerdict)
    const { stdin } = render(React.createElement(TuiApp, { deps: makeDeps(runner, makeHangingProvider()) }))
    await flush()
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    await flush()
    stdin.write('\x03') // Ctrl+C
    await flush()
    const dispatch = (runner as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith('Stop', expect.objectContaining({ stop_reason: 'aborted' }))
    })
  })

  it('UserPromptSubmit dispatch 透传 AbortSignal（hook 子进程随中断停）', async () => {
    const runner = makeHookRunner(() => noVerdict)
    const { stdin } = render(React.createElement(TuiApp, { deps: makeDeps(runner) }))
    await flush()
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    const dispatch = (runner as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch
    expect(dispatch).toHaveBeenCalledWith(
      'UserPromptSubmit',
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
