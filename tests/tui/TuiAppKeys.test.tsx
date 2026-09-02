/**
 * 回车提交 / 换行键位 / Ctrl+C 中断全链路测（用户质询补齐）：
 * ink-testing 模拟真实按键字节，走 TuiApp（协议客户端）→ 内联 HostSession → runLoop 全链，
 * 锁定「按键 → 宿主命令 → loop 中断/提交」整条通路——不是只测组件回调。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import { TuiApp } from '../../src/tui/TuiApp.js'
import { LLMProviderRegistryImpl } from '../../src/providers/registry.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { SkillRegistry } from '../../src/services/skill.js'
import type { Logger } from '../../src/services/logger.js'
import type { HistoryStore } from '../../src/services/history.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'

/** 单轮应答 provider：吐一行文本即结束 */
class OneShotProvider implements LLMProvider {
  readonly type = 'mock'
  async *run(): AsyncIterable<Delta> {
    yield { type: 'text', text: '收到，这是回复' }
    yield { type: 'done', stop_reason: 'end' }
  }
}

/** 挂起可中断 provider：吐首 delta 后挂住，signal abort 时以 SDK 真实语义
 *  （APIUserAbortError）reject——与 Anthropic MessageStream 手动 abort 同款 */
class HangProvider implements LLMProvider {
  readonly type = 'mock'
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    yield { type: 'text', text: '开始思考' }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 30_000)
      req.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        const e = new Error('Request was aborted.')
        e.name = 'APIUserAbortError'
        reject(e)
      }, { once: true })
    })
    yield { type: 'done', stop_reason: 'end' }
  }
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
/** T 线 T2：内存版 history——session/read 全量拉取经宿主 deps.history.restoreFull 读数，
 *  noop（恒空）会让 committed 重建失效；语义对齐 FileHistoryStore（append 可回放+fork 切 id）。 */
function memoryHistory(): HistoryStore {
  let curId = '2026-08-31T00-00-00-000Z-test'
  const lines: unknown[] = []
  return {
    append: (m: never) => { lines.push(m) },
    appendCompactBoundary() {},
    appendRewind() {},
    appendUsageStats() {},
    patchSessionMeta() {},
    loadAll() { return [{ sessionId: curId, createdAt: '', model: 'm', firstUser: '' }] },
    restore() { return [] },
    restoreFull() { return lines as never },
    setSessionId(id: string) { curId = id },
    forkSession(id: string) { curId = id },
    flushPendingSeed() {},
    currentSessionId() { return curId },
  } as unknown as HistoryStore
}

const config: Config = {
  ...emptyShellConfig(),
  providers: {
    m: { type: 'mock', baseURL: 'http://x', apiKey: 'k', models: ['m'], contextWindow: 32000 },
  },
  current: { name: 'm', model: 'm' },
  maxIterations: 10,
}

function makeDeps(provider: LLMProvider) {
  const reg = new LLMProviderRegistryImpl()
  reg.register(provider)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  return {
    providerRegistry: reg,
    tools: new ToolRegistryImpl(),
    logger: noopLogger,
    history: memoryHistory(),
    config,
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-keys-test-skills') }),
    mcpManager: null,
  }
}

const flush = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ink-testing 累积实例吞输入（既有教训）——每测卸载
afterEach(() => cleanup())

describe('回车提交 / 换行键位（TuiApp 全链路）', () => {
  it('输入 + Enter：提交进宿主跑轮，回复渲染到对话区', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(new OneShotProvider()) }))
    await flush()
    stdin.write('你好')
    await new Promise((r) => setTimeout(r, 150)) // burst 聚合窗闭合（输入体验批二期）
    stdin.write('\r')
    await flush(400)
    const f = lastFrame() ?? ''
    expect(f).toContain('你好')
    expect(f).toContain('收到，这是回复')
    // 旧病锁定：streamingText 延迟 commit 常驻曾让 placeholder 恒「处理中，Ctrl+C 中断」
    expect(f).not.toContain('处理中')
  })

  it('粘贴 token：草稿显 token、提交展开全文进对话（输入体验批二期集成）', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(new OneShotProvider()) }))
    await flush()
    const lines = Array.from({ length: 12 }, (_, i) => `粘贴行${String(i + 1).padStart(2, '0')}`)
    stdin.write(lines.join('\r'))
    await flush()
    // 草稿显 token（多行粘贴整块达 shouldTokenize 阈值 → 立即 token 化）
    expect(lastFrame() ?? '').toContain('[粘贴#1 +11 行]')
    stdin.write('\r')
    await flush(400)
    const f = lastFrame() ?? ''
    // 提交展开：transcript user 消息=粘贴全文（尾行在），token 形态不残留
    expect(f).toContain('粘贴行12')
    expect(f).not.toContain('[粘贴#1')
    expect(f).toContain('收到，这是回复')
  })

  it('Ctrl+J 换行 + Enter 提交：多行输入整体进对话（不拆轮不丢行）', async () => {
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(new OneShotProvider()) }))
    await flush()
    stdin.write('第一行')
    await flush()
    stdin.write('\n') // Ctrl+J（裸 \n）
    await flush()
    stdin.write('第二行')
    await flush()
    stdin.write('\r')
    await flush(400)
    const f = lastFrame() ?? ''
    expect(f).toContain('第一行')
    expect(f).toContain('第二行')
    expect(f).toContain('收到，这是回复')
  })
})

describe('Ctrl+C 中断（按键 → useInterrupt → 宿主 interrupt → loop abort → UI 全链路）', () => {
  it('思考挂起时 Ctrl+C：单按中断当前轮（⚠ 已中断 + 再按退出提示），不退出进程', async () => {
    const onExit = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, { deps: makeDeps(new HangProvider()), onExit }),
    )
    await flush()
    stdin.write('长任务')
    await flush()
    stdin.write('\r')
    // G2 16ms 合帧后首帧上屏链变长（delta 缓冲→timer→渲染），固定 300ms 偶发不足——waitFor 轮询
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('开始思考'), { timeout: 3000, interval: 50 }) // 轮已起且在挂起思考
    stdin.write('\x03') // Ctrl+C
    await flush(400)
    const f = lastFrame() ?? ''
    expect(f).toContain('再按一次 Ctrl+C 退出') // useInterrupt 首按提示
    expect(f).toContain('已中断') // activity 'aborted' → ActivityBar 终态（全链路闭环证据）
    expect(onExit).not.toHaveBeenCalled()
  })

  it('1.5s 窗口内第二次 Ctrl+C：走注入的优雅退出（不 process.exit）', async () => {
    const onExit = vi.fn()
    const { stdin } = render(React.createElement(TuiApp, { deps: makeDeps(new OneShotProvider()), onExit }))
    await flush()
    stdin.write('\x03')
    await flush(100)
    stdin.write('\x03')
    await flush(100)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('F-47：面板键序后 Ctrl+C 双击退出仍可用（pickerRef 泄漏回归锁；T2 语义=Esc 双击开 rewind → Ctrl+C 兜底关 → 双击退出）', async () => {
    const onExit = vi.fn()
    const { stdin } = render(React.createElement(TuiApp, { deps: makeDeps(new OneShotProvider()), onExit }))
    await flush()
    // 测试环境 /output 命令注册在全局单例（InputStream 分流面）——本文件未注册全局，
    // 两个 Esc 落主界面：T 线语义=双击 Esc 开 rewind 面板（armed 确认式分支与 rewind 分流共用计时）
    stdin.write('/output')
    await flush()
    stdin.write('\r')
    await flush(100)
    stdin.write('\x1b[B') // ↓ 移到可选条目（无面板时落主输入）
    await flush(100)
    stdin.write('\r') // 进查看器/提交空行
    await flush(100)
    stdin.write('\x1b') // Esc（回列表或主界面待清/计时）
    await flush(100)
    stdin.write('\x1b') // Esc（关面板或触发双击 rewind）
    await flush(100)
    // Ctrl+C①：无论 rewind 面板是否开着——全局兜底先关面板（87a6382）或单发提示
    stdin.write('\x03')
    await flush(100)
    // Ctrl+C②③：窗口内双击退出
    stdin.write('\x03')
    await flush(100)
    stdin.write('\x03')
    await flush(100)
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})

describe('M14-V4：轮末即 commit（§3.3 查因后方案一）', () => {
  it('轮完成后内容进 Static 不滞留动态区——第二轮提交后两轮内容齐全且不重复渲染 user 行', async () => {
    let turn = 0
    class TwoTurnProvider implements LLMProvider {
      readonly type = 'mock'
      async *run(): AsyncIterable<Delta> {
        turn++
        yield { type: 'text', text: `第${turn}轮结论` }
        yield { type: 'done', stop_reason: 'end' }
      }
    }
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(new TwoTurnProvider()) }))
    await flush()
    stdin.write('问一')
    await flush()
    stdin.write('\r')
    await flush(400)
    let f = lastFrame() ?? ''
    expect(f).toContain('问一')
    expect(f).toContain('第1轮结论')
    // 轮末已 commit：userInput 不再滞留动态区（延迟 commit 时代「问一」留在输入折叠区）
    expect(f).not.toContain('▸')
    stdin.write('问二')
    await flush()
    stdin.write('\r')
    await flush(400)
    f = lastFrame() ?? ''
    expect(f).toContain('问一')
    expect(f).toContain('第1轮结论')
    expect(f).toContain('问二')
    expect(f).toContain('第2轮结论')
  })
})
