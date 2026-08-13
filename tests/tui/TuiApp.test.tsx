/**
 * TuiApp /model 集成测（方案 §12）：命令分发 → ModelPicker → 切 config.current → StatusBar 更新。
 * 不驱动 runLoop（只测 UI 链路）；provider 切换的正确性靠 tsc + 单测覆盖。
 *
 * ink-testing-library：每次 stdin.write 后需 await 让 React state flush，
 * 否则连续 write 之间 cur.text 未更新（'\r' 提交到空串）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { TuiApp } from '../../src/tui/TuiApp.js'
import { LLMProviderRegistryImpl } from '../../src/providers/registry.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'
import type { Config } from '../../src/services/config.js'
import type { Logger } from '../../src/services/logger.js'
import type { HistoryStore } from '../../src/services/history.js'
import type { Message } from '../../src/core/types.js'

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
  loadAll() {
    return []
  },
  restore() {
    return []
  },
  setSessionId() {},
} as unknown as HistoryStore

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

function makeDeps(overrides: Partial<{ config: Config }> = {}) {
  return {
    providerRegistry: new LLMProviderRegistryImpl(),
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: noopHistory,
    config: overrides.config ?? config,
  }
}

describe('TuiApp /model', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })

  it('初始 StatusBar 显示当前 model', () => {
    const { lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    expect(lastFrame() ?? '').toContain('glm-5.2')
  })

  it('/model → 弹 ModelPicker（含所有 provider/model）', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    stdin.write('/model')
    await flush()
    stdin.write('\r')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('切换供应商/模型')
    expect(f).toContain('glm-5.2')
    expect(f).toContain('deepseek-v4')
  })

  it('↓ 选中 deepseek-v4 + 回车 → StatusBar 切到新 model', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    stdin.write('/model')
    await flush()
    stdin.write('\r')
    await flush()
    // ↓ 选中第二项（deepseek-v4）
    stdin.write('\u001b[B')
    await flush()
    stdin.write('\r')
    await flush()
    const f = lastFrame() ?? ''
    // picker 已关 + StatusBar 显示新 model
    expect(f).not.toContain('切换供应商/模型')
    expect(f).toContain('deepseek-v4')
  })

  it('Esc → 关闭 picker（config 不变）', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    stdin.write('/model')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\u001b') // Esc
    await flush()
    const f = lastFrame() ?? ''
    expect(f).not.toContain('切换供应商/模型')
    expect(f).toContain('glm-5.2') // 仍是原 model
  })

  it('切 model 后 submit 用新 provider（registry.getByType 收到新 type）', async () => {
    // 用 spy registry 验证：切到 openai 后 submit 调 getByType('openai')
    const spyReg = new LLMProviderRegistryImpl()
    const getByType = vi.spyOn(spyReg, 'getByType')
    // 注册两个 stub provider（不真跑，只验 getByType 入参）
    spyReg.register({ type: 'anthropic', run: async function* () {} } as never)
    spyReg.register({ type: 'openai', run: async function* () {} } as never)

    const { stdin } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: spyReg, tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config },
      }),
    )
    // 切到 deepseek（openai 协议）
    stdin.write('/model')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\u001b[B')
    await flush()
    stdin.write('\r')
    await flush()
    // submit 一条消息 → 触发 runLoop → getByType
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    // 让 runLoop 的微任务跑（provider.run 是空 async generator，会立即 done）
    await flush()
    expect(getByType).toHaveBeenCalledWith('openai')
  })

  // ---------- /history ----------
  it('/history → 显示历史列表（含 firstUser）', async () => {
    const history = {
      ...noopHistory,
      loadAll: () => [
        { sessionId: 's1', createdAt: '2026-08-13T10:00:00.000Z', model: 'glm-5.2', firstUser: '帮我写函数' },
      ],
    } as unknown as HistoryStore
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history, config },
      }),
    )
    stdin.write('/history')
    await flush()
    stdin.write('\r')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('恢复历史会话')
    expect(f).toContain('帮我写函数')
  })

  it('选中 → restore 注入 + setSessionId 续写 + committed 重建', async () => {
    const restored: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '之前问的问题' }] },
      { role: 'assistant', content: [{ type: 'text', text: '之前的回答' }] },
    ]
    const restore = vi.fn(() => restored)
    const setSessionId = vi.fn()
    const history = {
      ...noopHistory,
      loadAll: () => [
        { sessionId: 's1', createdAt: '2026-08-13T10:00:00.000Z', model: 'glm-5.2', firstUser: '之前问的问题' },
      ],
      restore,
      setSessionId,
    } as unknown as HistoryStore
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history, config },
      }),
    )
    stdin.write('/history')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 选中第一项恢复
    await flush()
    expect(restore).toHaveBeenCalledWith('s1')
    expect(setSessionId).toHaveBeenCalled()
    // committed 重建：含恢复的 assistant 文本（messagesToCommitted）
    expect(lastFrame() ?? '').toContain('之前的回答')
  })

  it('空历史 → 显示「无历史会话」', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config },
      }),
    )
    stdin.write('/history')
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('无历史会话')
  })
})
