/**
 * TuiApp /model 集成测（方案 §12）：命令分发 → ModelPicker → 切 config.current → StatusBar 更新。
 * 不驱动 runLoop（只测 UI 链路）；provider 切换的正确性靠 tsc + 单测覆盖。
 *
 * ink-testing-library：每次 stdin.write 后需 await 让 React state flush，
 * 否则连续 write 之间 cur.text 未更新（'\r' 提交到空串）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { TuiApp } from '../../src/tui/TuiApp.js'
import { LLMProviderRegistryImpl } from '../../src/providers/registry.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { readClipboardImage } from '../../src/services/clipboard.js'

// M10 修复批：粘贴链路 mock 系统剪贴板（真实实现 spawn powershell，测试环境不可用且会真读剪贴板）
vi.mock('../../src/services/clipboard.js', () => ({
  readClipboardImage: vi.fn(),
}))
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { SkillRegistry } from '../../src/services/skill.js'
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
  appendCompactBoundary() {},
  loadAll() {
    return []
  },
  restore() {
    return []
  },
  restoreFull() {
    return []
  },
  setSessionId() {},
  currentSessionId() {
    return 'test-session'
  },
} as unknown as HistoryStore

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

function makeDeps(overrides: Partial<{ config: Config }> = {}) {
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  return {
    providerRegistry: new LLMProviderRegistryImpl(),
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: noopHistory,
    config: overrides.config ?? config,
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    // M6：tmp 目录实例（不触真实 ~/.ecode/skills；测试不 load，空注册表即可）
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-tui-test-skills') }),
    mcpManager: null,
  }
}

// ink-testing 的 instances[] 只增不减，累积的挂载实例会概率性吞掉后续实例的输入
// （单测恒绿、随前置渲染数增多而飘——M10 修复批新增粘贴用例时暴露）。每测卸载全部实例根治。
afterEach(() => cleanup())

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
    stdin.write('\r') // 第二个回车=执行（统一两段式）
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
    stdin.write('\r') // 第二个回车=执行（统一两段式）
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
    stdin.write('\r') // 第二个回车=执行（统一两段式）
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
        deps: { providerRegistry: spyReg, tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config, skillRegistry: makeDeps().skillRegistry, mcpManager: null },
      }),
    )
    // 切到 deepseek（openai 协议）
    stdin.write('/model')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
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
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history, config, skillRegistry: makeDeps().skillRegistry, mcpManager: null },
      }),
    )
    stdin.write('/history')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
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
    const restoreFull = vi.fn(() => restored)
    const setSessionId = vi.fn()
    const currentSessionId = vi.fn(() => 'old-session')
    const history = {
      ...noopHistory,
      loadAll: () => [
        { sessionId: 's1', createdAt: '2026-08-13T10:00:00.000Z', model: 'glm-5.2', firstUser: '之前问的问题' },
      ],
      restoreFull,
      setSessionId,
      currentSessionId,
    } as unknown as HistoryStore
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history, config, skillRegistry: makeDeps().skillRegistry, mcpManager: null },
      }),
    )
    stdin.write('/history')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
    await flush()
    stdin.write('\r') // 选中第一项恢复
    await flush()
    expect(restoreFull).toHaveBeenCalledWith('s1')
    expect(setSessionId).toHaveBeenCalled()
    // committed 重建：含恢复的 assistant 文本（messagesToCommitted）
    expect(lastFrame() ?? '').toContain('之前的回答')
  })

  it('空历史 → 显示「无历史会话」', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config, skillRegistry: makeDeps().skillRegistry, mcpManager: null },
      }),
    )
    stdin.write('/history')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
    await flush()
    expect(lastFrame() ?? '').toContain('无历史会话')
  })

  // ---------- /setup + 配置无效态（D10）----------
  it('配置无效（空壳）→ banner 渲染（cli 传入）', () => {
    const { lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config: emptyShellConfig(), skillRegistry: makeDeps().skillRegistry, mcpManager: null },
        banner: '配置不完整：缺少 API Key',
      }),
    )
    expect(lastFrame() ?? '').toContain('配置不完整')
  })

  it('配置无效 submit → banner 提示 /setup（不 runLoop）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config: emptyShellConfig(), skillRegistry: makeDeps().skillRegistry, mcpManager: null },
      }),
    )
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('配置不完整')
  })

  it('/setup → Wizard 显示（第一步 type）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history: noopHistory, config: emptyShellConfig(), skillRegistry: makeDeps().skillRegistry, mcpManager: null },
      }),
    )
    stdin.write('/setup')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
    await flush()
    expect(lastFrame() ?? '').toContain('协议类型')
    expect(lastFrame() ?? '').toContain('1/5')
  })
})

describe('TuiApp /cost + 命令补全（M5）', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })

  it('/cost → 显示本轮 token 四维 + 成本（systemMsgs 渲染在输入框上方）', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    await flush()
    stdin.write('/cost')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('本轮 token')
    expect(f).toContain('input 0')
    expect(f).toContain('会话累计成本')
  })

  it('/com 回车 → 补全执行 /compact（不发出 /com 当未知命令）', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    await flush()
    stdin.write('/com')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 第二个回车=执行（统一两段式）
    await flush()
    const f = lastFrame() ?? ''
    // /com 补全为 /compact（problem 2 修复）；新会话 messages 空 → compactManual 反馈「无可压缩」(problem 3)
    expect(f).toContain('无可压缩')
    expect(f).not.toContain('未知命令') // 不再当未知命令发出
  })
})

// ---------- M10 修复批：图片粘贴附件行（真机 UX 三问题：提示不消失/空文本发不出/不在输入区显示） ----------

describe('TuiApp 图片粘贴附件行（M10 修复批）', () => {
  /** 1x1 PNG（真实字节——submit 组装走 imageBlocksFromPaths 真读文件） */
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  function setup(): { deps: ReturnType<typeof makeDeps>; getByType: ReturnType<typeof vi.spyOn> } {
    const spyReg = new LLMProviderRegistryImpl()
    spyReg.register({ type: 'anthropic', run: async function* () {} } as never)
    const getByType = vi.spyOn(spyReg, 'getByType')
    const deps = { ...makeDeps(), providerRegistry: spyReg }
    return { deps, getByType }
  }

  /**
   * 重试型回车：ink-testing 偶发丢键（write 的 readable 事件在监听器挂载竞态下静默丢失，
   * 累积实例越多概率越高）。回车幂等——submit 成功后 busy 态 inactive 吞掉多余回车，
   * 失败后空闲态空文本无附件也被空守卫拦住，重写安全。
   */
  async function pressEnterUntil(
    stdin: { write: (s: string) => void },
    cond: () => boolean,
    tries = 6,
  ): Promise<void> {
    for (let i = 0; i < tries && !cond(); i++) {
      stdin.write('\r')
      for (let j = 0; j < 3 && !cond(); j++) await flush()
    }
  }

  it('Alt+V → 附件行常驻输入区（标签可见），不再走 systemMsgs 一次性提示', async () => {
    const png = path.join(os.tmpdir(), `ecode-paste-${Date.now()}.png`)
    fs.writeFileSync(png, PNG_1x1)
    vi.mocked(readClipboardImage).mockResolvedValue({ path: png, bytes: PNG_1x1.length })
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: setup().deps }))
    await flush()
    stdin.write('\x1bv') // Alt+V（ESC+v 元序列）
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('图片#1')
    expect(f).toContain('回车随消息发送')
    expect(f).not.toContain('已粘贴') // 旧 systemMsgs 提示退役（发送后仍挂着的根因）
  })

  it('粘贴后空文本回车 → 纯图消息照发（标签即消息文本），发送后附件行消失', async () => {
    const png = path.join(os.tmpdir(), `ecode-paste-${Date.now()}.png`)
    fs.writeFileSync(png, PNG_1x1)
    vi.mocked(readClipboardImage).mockResolvedValue({ path: png, bytes: PNG_1x1.length })
    const { deps, getByType } = setup()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    expect(lastFrame() ?? '').toContain('图片#1')
    await pressEnterUntil(stdin, () => getByType.mock.calls.length > 0)
    await flush()
    await flush() // runLoop 微任务（空 generator 立即完）
    expect(getByType).toHaveBeenCalledWith('anthropic') // 消息真的进了 runLoop
    const f = lastFrame() ?? ''
    expect(f).not.toContain('回车随消息发送') // 附件行随发送消失
    expect(f).toContain('图片#1') // 转录显示标签（标签即消息文本）
  })

  it('粘贴后带文本回车 → 文本 + 标签同发', async () => {
    const png = path.join(os.tmpdir(), `ecode-paste-${Date.now()}.png`)
    fs.writeFileSync(png, PNG_1x1)
    vi.mocked(readClipboardImage).mockResolvedValue({ path: png, bytes: PNG_1x1.length })
    const { deps, getByType } = setup()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    stdin.write('看下这张图')
    await flush()
    await pressEnterUntil(stdin, () => getByType.mock.calls.length > 0)
    await flush()
    await flush()
    expect(getByType).toHaveBeenCalledWith('anthropic')
    const f = lastFrame() ?? ''
    expect(f).toContain('看下这张图')
    expect(f).toContain('图片#1')
    expect(f).not.toContain('回车随消息发送')
  })

  it('剪贴板无图 → 一行提示（保留），无附件行', async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(null)
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: setup().deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('剪贴板无图片')
    expect(f).not.toContain('回车随消息发送')
  })
})
