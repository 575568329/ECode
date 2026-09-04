const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/**
 * 2026-09-04 用户点名「从 TUI 退出 serve」集成流：
 * 附着态 /devices 面板 → 停止后台 serve（二次确认）→ 进程级 stop + 熔断自愈 + 降级本地续聊。
 * fetch 全局 mock（捕获 stop 调用）；readServerReg/resurrect mock 隔离真 daemon。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import { TuiApp, type TuiHost } from '../../src/tui/TuiApp.js'
import type { ProtocolCommand, CommandResult } from '../../src/protocol/types.js'
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
const readServerRegMock = vi.fn()
const resurrectMock = vi.fn()
vi.mock('../../src/cli/daemon.js', () => ({
  readServerReg: (...a: unknown[]) => readServerRegMock(...(a as [])),
  resurrectDaemonReg: (...a: unknown[]) => resurrectMock(...(a as [])),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const config: Config = {
  providers: { astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'] } },
  current: { name: 'astron', model: 'glm-5.2' },
  maxIterations: 50,
  bashMaxOutputBytes: 30720,
  logLevel: 'info',
}
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const noopHistory = {
  append() {}, appendCompactBoundary() {}, appendRewind() {}, appendUsageStats() {}, appendThinking() {},
  loadAll() { return [] }, restore() { return [] }, restoreFull() { return [] },
  setSessionId() {}, currentSessionId() { return 's-attached' }, flushPendingSeed() {},
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
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-stopflow-skills') }),
    mcpManager: null,
  }
}

describe('TUI 停止 serve 流（/devices 面板）', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
    readServerRegMock.mockReset().mockReturnValue({ port: 59999, token: 'tk-stop', pid: process.pid })
    resurrectMock.mockReset()
    fetchMock.mockReset()
    // 默认：/api/health 探活失败（probe 落本地表）；/api/cmd 捕获 stop；其余空 ok
    fetchMock.mockImplementation(async (url: string | URL, init?: { body?: string }) => {
      const u = String(url)
      const body = init?.body ?? ''
      if (u.includes('/api/health')) throw new Error('no daemon')
      if (u.includes('/api/devices')) return { ok: true, json: async () => ({ devices: [] }) } as never
      if (u.includes('/api/cmd') && body.includes('"stop"')) {
        return { ok: true, json: async () => ({ ok: true, stopping: true }) } as never
      }
      return { ok: true, json: async () => ({}) } as never
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('附着态停止 serve：进程级 stop 调用 + 防自愈 + 降级本地续聊 + 面板关闭', async () => {
    let prompts = 0
    let disposed = false
    const host: TuiHost & { setSessionId?: unknown } = {
      send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
        if (cmd.op === 'session/new') return { ok: true, sessionId: 's-stop' }
        if (cmd.op === 'prompt') {
          prompts += 1
          return { ok: true, routed: 'Started', sessionId: 's-stop' }
        }
        return { ok: true }
      },
      subscribe: () => () => {},
      dispose: () => {
        disposed = true
      },
      ...({ setSessionId: () => {} } as never),
    }
    const localSend = vi.fn(async (cmd: ProtocolCommand): Promise<CommandResult> => {
      if (cmd.op === 'prompt') return { ok: true, routed: 'Started' }
      return { ok: true }
    })
    const localFallback = vi.fn(() => ({
      ...makeDeps(),
      history: { ...noopHistory, currentSessionId: () => 's-stop' } as unknown as HistoryStore,
      project: {
        ensureDefault: () =>
          ({
            send: localSend,
            subscribe: () => () => {},
            dispose: () => {},
          }) as unknown as TuiHost,
      },
    }))
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: makeDeps() as never,
        host: host as never,
        localFallback: localFallback as never,
      }),
    )

    // 打开 /devices 面板（两段式回车：首段回车被补全菜单消费回填，二段才提交）；
    // 面板打开时序用 waitFor（固定 sleep 在 ink-testing 异步渲染下不稳）
    stdin.write('/devices')
    await flush()
    stdin.write('\r')
    await flush(80)
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('本机服务  http://127.0.0.1:59999'), { timeout: 5000 })
    expect(lastFrame() ?? '').toContain('访问令牌')
    expect(lastFrame() ?? '').not.toContain('tk-stop') // token 默认遮蔽（≤12 位全掩码；安全席 P1）

    // 光标默认在首 item=token 行——↓ 一次到停止行（token 行已 item 化）
    stdin.write('\u001b[B')
    await flush(60)
    stdin.write('\r')
    await flush(80)
    expect(lastFrame() ?? '').toContain('再回车确认')
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/cmd'), expect.objectContaining({ body: expect.stringContaining('"stop"') }))
    stdin.write('\r')
    // 等停进程+降级链完成
    await vi.waitFor(
      () => expect(localFallback).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    )
    // 契约断言（测试席 P2·六批）：sid 透传（同 id 续写同一会话文件）+ 旧 host 已 dispose
    expect(localFallback.mock.calls[0]?.[0]).toBe('s-attached')
    expect(disposed).toBe(true)
    // 主动停止≠事故：不出现「服务不可达」吓人文案（degradeToLocal user-stop 语义）
    expect(lastFrame() ?? '').not.toContain('服务不可达')
    // 进程级 stop 调用（POST /api/cmd + op stop + Bearer）
    const stopCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cmd') && String(c[1]?.body).includes('"stop"'))
    expect(stopCall).toBeDefined()
    expect((stopCall?.[1] as { headers?: Record<string, string> }).headers.authorization).toBe('Bearer tk-stop')
    // 面板已关 + 提示可见
    const f = lastFrame() ?? ''
    expect(f).toContain('后台 serve 已停止')
    expect(f).not.toContain('访问令牌  tk-stop')
    // 本地续聊可用：prompt 走本地宿主（waitFor——降级重渲后新闭包才绑定 localHost）
    await flush(300) // 降级重渲 settle
    stdin.write('停服后本地消息')
    await flush()
    stdin.write('\r')
    await vi.waitFor(
      () => expect(localSend.mock.calls.some((c) => String(JSON.stringify(c[0])).includes('停服后本地消息'))).toBe(true),
      { timeout: 3000 },
    )
    // 防自愈锁（测试席 P1·六批——特性核心语义）：G3 tick 8s 窗过后 daemon 不复活
    await sleep(9000)
    expect(resurrectMock).not.toHaveBeenCalled()
  }, 30000)
})
