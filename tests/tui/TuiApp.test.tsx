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

/** 每测深拷贝 config（审阅 P0-1：模块级共享 config 被 TUI /model 的宿主 handler 就地改写后
 *  污染后续测试——/model 的 setConfig→send model/set→inline HostSession 改 cfg.current 写穿
 *  共享对象。深拷贝使每测独立，与 serve 每项目浅克隆治串台同族） */
function cloneConfig(c: Config): Config {
  return {
    ...c,
    providers: Object.fromEntries(Object.entries(c.providers).map(([k, p]) => [k, { ...p }])),
    current: { ...c.current },
  }
}

function makeDeps(overrides: Partial<{ config: Config }> = {}) {
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  return {
    providerRegistry: new LLMProviderRegistryImpl(),
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: noopHistory,
    config: overrides.config ?? cloneConfig(config),
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

describe('TuiApp /restart（F-41）', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })

  it('两段式回车后调用 onRestart 句柄（并提示正在重启）', async () => {
    const onRestart = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, { deps: makeDeps(), onRestart }),
    )
    await flush()
    stdin.write('/restart')
    await flush()
    stdin.write('\r') // 补全填入
    await flush()
    stdin.write('\r') // 执行
    await flush(100)
    expect(lastFrame() ?? '').toContain('正在重启') // 提示渲染（400ms 前）
    await vi.waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1), { timeout: 3000, interval: 50 })
  })

  it('未注入 onRestart（serve/旧宿主）→ 提示不支持且不崩', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() }))
    await flush()
    stdin.write('/restart')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('不支持重启')
  })
})

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
        // 审阅修复：走 makeDeps 副本（原直传模块级 config——切 model 的宿主 handler 就地写穿
        // 共享源，污染后续图片粘贴测试的 current）
        deps: { ...makeDeps(), providerRegistry: spyReg },
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

  it('选中 → session/restore 命令恢复 + 继续原会话（不 fork）+ committed 重建', async () => {
    const restored: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '之前问的问题' }] },
      { role: 'assistant', content: [{ type: 'text', text: '之前的回答' }] },
    ]
    const restoreFull = vi.fn(() => restored)
    const forkSession = vi.fn()
    // 2026-09-02 用户拍板：恢复=继续原会话（同 id 续写，不再 fork 复制）——Embedded 端口
    // 在 restoreFrom 外还切本地续写指针（setSessionId），落盘/读面都以原会话 id 为准
    let curId = '2026-08-13T10-00-00-000Z-old'
    const history = {
      ...noopHistory,
      loadAll: () => [
        { sessionId: '2026-08-13T10-00-00-000Z-s1', createdAt: '2026-08-13T10:00:00.000Z', model: 'glm-5.2', firstUser: '之前问的问题' },
      ],
      restoreFull,
      setSessionId: (id: string) => {
        curId = id
      },
      forkSession: (id: string, lines: never, model: never) => {
        forkSession(id, lines, model)
        curId = id
      },
      currentSessionId: () => curId,
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
    await flush() // T 线 T2：恢复走 session/restore 命令（异步链）——宿主 ensureConversation 真读历史
    expect(restoreFull).toHaveBeenCalledWith('2026-08-13T10-00-00-000Z-s1')
    expect(forkSession).not.toHaveBeenCalled() // 不再 fork 复制——继续原会话
    expect(curId).toBe('2026-08-13T10-00-00-000Z-s1') // 续写指针切到原会话 id
    // committed 重建：含恢复的 assistant 文本（session/read 全量拉取后 messagesToCommitted）
    expect(lastFrame() ?? '').toContain('之前的回答')
  })

  it('initialHistorySessionId 启动即恢复（--history 入口的组件面）', async () => {
    const restored: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '启动前问的' }] },
      { role: 'assistant', content: [{ type: 'text', text: '启动前的回答' }] },
    ]
    const forkSession = vi.fn()
    let curId = '2026-08-13T10-00-00-000Z-old'
    const history = {
      ...noopHistory,
      loadAll: () => [{ sessionId: '2026-08-13T10-00-00-000Z-s1', createdAt: '2026-08-13T10:00:00.000Z', model: 'glm-5.2', firstUser: '启动前问的' }],
      restoreFull: () => restored,
      setSessionId: (id: string) => {
        curId = id
      },
      forkSession: (id: string, lines: never, model: never) => {
        forkSession(id, lines, model)
        curId = id
      },
      currentSessionId: () => curId,
    } as unknown as HistoryStore
    const { lastFrame } = render(
      React.createElement(TuiApp, {
        deps: { providerRegistry: new LLMProviderRegistryImpl(), tools: new ToolRegistryImpl(), logger: noopLogger, history, config, skillRegistry: makeDeps().skillRegistry, mcpManager: null },
        initialHistorySessionId: '2026-08-13T10-00-00-000Z-s1',
      }),
    )
    await flush()
    await flush() // 恢复命令异步链
    expect(lastFrame() ?? '').toContain('启动前的回答') // committed 重建
    expect(forkSession).not.toHaveBeenCalled() // 继续原会话（不 fork）
    expect(curId).toBe('2026-08-13T10-00-00-000Z-s1')
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

describe('TuiApp 图片粘贴标签内嵌（M10 真机修复批 v2）', () => {
  /** 1x1 PNG（真实字节——submit 组装走 imageBlocksFromPaths 真读文件） */
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  /** stub provider 捕获 run 请求（断言最后 user 消息的 blocks 附着/剪枝） */
  function setup(): { deps: ReturnType<typeof makeDeps>; getByType: ReturnType<typeof vi.spyOn>; lastUserBlocks: Array<{ type: string }> } {
    const lastUserBlocks: Array<{ type: string }> = []
    const spyReg = new LLMProviderRegistryImpl()
    spyReg.register({
      type: 'anthropic',
      run: async function* (req: { messages: Array<{ role: string; content: unknown }> }) {
        const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
        const content = lastUser?.content
        lastUserBlocks.length = 0
        if (Array.isArray(content)) {
          lastUserBlocks.push(...content.map((c) => ({ type: (c as { type: string }).type })))
        } else if (typeof content === 'string') {
          lastUserBlocks.push({ type: 'text' })
        }
      },
    } as never)
    const getByType = vi.spyOn(spyReg, 'getByType')
    const deps = { ...makeDeps(), providerRegistry: spyReg }
    return { deps, getByType, lastUserBlocks }
  }

  /**
   * 重试型回车：ink-testing 偶发丢键（write 的 readable 事件在监听器挂载竞态下静默丢失，
   * 累积实例越多概率越高）。回车幂等——submit 成功后 busy 态 inactive 吞掉多余回车，
   * 失败后空闲态空文本也被空守卫拦住，重写安全。
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

  /** 粘贴一张真实图（mock 剪贴板），返回附件 png 路径 */
  function mockOnePaste(): string {
    const png = path.join(os.tmpdir(), `ecode-paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
    fs.writeFileSync(png, PNG_1x1)
    vi.mocked(readClipboardImage).mockResolvedValue({ path: png, bytes: PNG_1x1.length })
    return png
  }

  it('Alt+V → 短标签出现在输入框文本内（不在别处），旧 systemMsgs 提示退役', async () => {
    mockOnePaste()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: setup().deps }))
    await flush()
    stdin.write('\x1bv') // Alt+V（ESC+v 元序列）
    await flush()
    await flush() // 剪贴板 mock 微任务 + 插入文本
    const f = lastFrame() ?? ''
    expect(f).toContain('[图片#1]')
    expect(f).not.toContain('已粘贴')
    expect(f).not.toContain('回车随消息发送') // v1 附件行同样退役
  })

  it('粘贴后直接回车 → 纯图消息（标签即文本）+ image block 附着', async () => {
    mockOnePaste()
    const { deps, getByType, lastUserBlocks } = setup()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('[图片#1]')
    await pressEnterUntil(stdin, () => getByType.mock.calls.length > 0)
    // runLoop 消费流与 getByType 之间有异步间隙（getByType 在 doSubmit 内、blocks 在流消费后
    // 填充）：全量负载下两次 flush 不够（复审 P1 负载 flake），轮询等 lastUserBlocks 填充
    for (let i = 0; i < 100 && lastUserBlocks.length === 0; i++) await flush()
    expect(getByType).toHaveBeenCalledWith('anthropic')
    expect(lastUserBlocks).toContainEqual({ type: 'image' }) // blocks 真附着在 user 消息上
    expect(lastFrame() ?? '').toContain('[图片#1]') // 转录显示标签
  })

  it('粘贴 + 文本 → 文本与标签同发（一条消息带图）', async () => {
    mockOnePaste()
    const { deps, getByType, lastUserBlocks } = setup()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    await flush()
    stdin.write('看下这张图')
    await flush()
    await pressEnterUntil(stdin, () => getByType.mock.calls.length > 0)
    // 同上：轮询等 blocks 填充（负载下的时序间隙）
    for (let i = 0; i < 100 && lastUserBlocks.length === 0; i++) await flush()
    expect(getByType).toHaveBeenCalledWith('anthropic')
    expect(lastFrame() ?? '').toContain('看下这张图')
    expect(lastUserBlocks).toContainEqual({ type: 'image' })
  })

  it('删掉标签文本再提交 → 图不发送（剪枝：文本无引用则不组装 blocks）', async () => {
    mockOnePaste()
    const { deps, getByType, lastUserBlocks } = setup()
    const { stdin } = render(React.createElement(TuiApp, { deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    await flush()
    // '[图片#1] ' 共 8 字素，逐个退格删净
    for (let i = 0; i < 8; i++) {
      stdin.write('\x7f')
      await flush()
    }
    stdin.write('hi')
    await flush()
    await pressEnterUntil(stdin, () => getByType.mock.calls.length > 0)
    await flush()
    await flush()
    expect(getByType).toHaveBeenCalledWith('anthropic')
    expect(lastUserBlocks).not.toContainEqual({ type: 'image' }) // 引用没了 → 图剪掉
  })

  it('剪贴板无图 → 一行提示，输入框不插标签', async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(null)
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: setup().deps }))
    await flush()
    stdin.write('\x1bv')
    await flush()
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('剪贴板无图片')
    expect(f).not.toContain('[图片#1]')
  })
})
