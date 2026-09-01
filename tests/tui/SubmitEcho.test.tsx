/**
 * 提交即锁死（2026-09-01）：prompt 发送成功 → 用户消息全文 echo 进 Static——执行期即可
 * 回看自己发的内容；动态区 2 行折叠只剩发送失败回执窗口在用（消息不进 transcript 不能
 * 乐观 echo，见 doSubmit 注释）。
 *
 * fake TuiHost（协议面最小实现）驱动：prompt 回执可控成败、transcript 权威在 host 侧
 * （session/read 供轮末全量重建）、subscribe 捕获事件通道供测试发帧。不触 provider/网络。
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

// 粘贴链路 mock 系统剪贴板（真实实现 spawn powershell，测试环境不可用）
vi.mock('../../src/services/clipboard.js', () => ({ readClipboardImage: vi.fn() }))

const config: Config = {
  providers: { astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'] } },
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
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-tui-echo-test-skills') }),
    mcpManager: null,
  }
}

/** 大段单行粘贴（>800 字符触发 token 化）——头部标记用于断言全文是否上屏：
 *  动态区折叠是保尾语义（foldStreamText tail 窗口），头部在失败窗口恒不可见 */
const PASTE = `ZZHEADZZ-${'x'.repeat(900)}`

function makeFakeHost(opts: { failPrompt?: boolean } = {}) {
  const lines: HistoryLine[] = []
  let handler: ((ev: ProtocolEvent) => void) | null = null
  const host: TuiHost = {
    send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
      if (cmd.op === 'prompt') {
        if (opts.failPrompt) return { ok: false, error: '发送失败（测试）' }
        lines.push({ role: 'user', content: [{ type: 'text', text: cmd.text }] } as Message)
        return { ok: true, routed: 'Started', sessionId: 's-echo' }
      }
      if (cmd.op === 'session/read') return { ok: true, value: lines }
      return { ok: true }
    },
    subscribe: (h: (ev: ProtocolEvent) => void) => {
      handler = h
      return () => {
        handler = null
      }
    },
    dispose: () => {},
  }
  return {
    host,
    lines,
    fire: (ev: ProtocolEvent): void => {
      handler?.(ev)
    },
  }
}

/** 输入长文本并提交（token 化阈值按插入文本大小判定，单次 stdin.write 即触发） */
async function typeAndSubmit(stdin: { write: (s: string) => void }): Promise<void> {
  stdin.write(PASTE)
  await flush()
  stdin.write('\r')
  await flush()
}

describe('提交即锁死（发送成功全文进 Static）', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })
  afterEach(() => cleanup())

  it('发送成功 → 全文立即上屏（折叠头消失，头部标记可见）', async () => {
    const { host } = makeFakeHost()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    await typeAndSubmit(stdin)
    await vi.waitFor(() => {
      // ink-testing 的帧会持续携带已 flush 的 Static 内容——末帧含头部标记=全文已上屏
      expect(lastFrame() ?? '').toContain('ZZHEADZZ')
    }, { timeout: 2000, interval: 30 })
    // 动态区折叠头已退场（userInput 清空——全文在 Static，无需折叠）
    expect(lastFrame() ?? '').not.toContain('行已折叠')
  })

  it('轮末 turn/completed 全量重建 → 已上屏的 echo 不重印（无重复）', async () => {
    const { host, fire } = makeFakeHost()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    await typeAndSubmit(stdin)
    await vi.waitFor(() => {
      expect(lastFrame() ?? '').toContain('ZZHEADZZ')
    }, { timeout: 2000, interval: 30 })
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: null, iter: 1 })
    fire({ type: 'turn/completed', seq: 2, turnId: 't1' })
    await flush(60)
    // transcript 投影重建后末帧全文仍只一份（Static 游标不回退，echo 位置不重印）
    const last = lastFrame() ?? ''
    expect(last.split('ZZHEADZZ').length - 1).toBe(1)
    expect(last).not.toContain('行已折叠')
  })

  it('发送失败 → 不 echo（transcript 无此消息），动态区保留折叠显示', async () => {
    const { host, lines } = makeFakeHost({ failPrompt: true })
    const { stdin, frames, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(), host }))
    await flush()
    await typeAndSubmit(stdin)
    await flush(60)
    // 失败窗口：动态区 2 行折叠仍显示（折叠保尾，头部标记不可见——全文未上屏）
    expect(lastFrame() ?? '').toContain('行已折叠')
    expect(frames.join('')).not.toContain('ZZHEADZZ')
    expect(lines).toHaveLength(0)
  })
})
