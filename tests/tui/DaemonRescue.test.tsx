/**
 * 2026-09-02 TUI 稳定性拍板：daemon 失联自愈链（用户定调——附着状态不能打断 TUI 干活）。
 * 覆盖：
 * ① 命令 NETWORK 失败 → resurrectDaemonReg 重拉成功 → transport.reattach 热重连 →
 *    会话 restore 冷拉回 → 原 prompt 重试成功（用户输入不丢）——关键命令全序断言；
 * ② 重拉失败 → localFallback 本地降级（宿主切换+同 id 续写+事件重订阅）→ **首条 prompt 走
 *    本地宿主**（fake 带 dispose→DISPOSED 语义——审阅 P0-1 假绿修复：真机降级后旧 transport
 *    已销毁，DISPOSED≠NETWORK 不入自愈，首条消息必失败）；
 * ③ 会话已建立后（第二个 prompt）失联 → 降级 → prompt 重试走本地；
 * ④ 附着态 restore：transport 先切目标 id、失败回滚旧 id。
 * resurrectDaemonReg 经 vi.mock 打桩；真拉起面（拉起锁/墓碑/持锁复用）在 daemon.test.ts 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import { TuiApp, type TuiHost } from '../../src/tui/TuiApp.js'
import type { ProtocolCommand, CommandResult } from '../../src/protocol/types.js'
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

const resurrectMock = vi.fn()
const readServerRegMock = vi.fn(() => null)
// readServerReg 必须随 mock 导出（R6 批起 rescueDaemon 拉起前读注册做 pid 判别——mock 工厂
// 缺它=TypeError，rescue 链全断、重试/降级静默不走。回归锁：d8f643a 提交门漏跑本文件）
vi.mock('../../src/cli/daemon.js', () => ({
  resurrectDaemonReg: (...args: unknown[]) => resurrectMock(...args),
  readServerReg: (...args: unknown[]) => readServerRegMock(...args),
}))

const config: Config = {
  providers: { astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'] } },
  current: { name: 'astron', model: 'glm-5.2' },
  maxIterations: 50,
  bashMaxOutputBytes: 30720,
  logLevel: 'info',
}
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const noopHistory = {
  append() {}, appendCompactBoundary() {}, appendRewind() {}, appendUsageStats() {}, patchSessionMeta() {},
  loadAll() { return [] }, restore() { return [] }, restoreFull() { return [] },
  setSessionId() {}, forkSession() {}, flushPendingSeed() {}, currentSessionId() { return 'test-session' },
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
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-rescue-skills') }),
    mcpManager: null,
  }
}

/** 死透的附着 transport：dispose 后 send 返 DISPOSED（真实 MultiTransport 语义——防假绿） */
function makeDeadTransport(failSessionNew: boolean): { host: TuiHost; reattach: ReturnType<typeof vi.fn>; setSessionId: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = []
  const reattach = vi.fn()
  const setSessionId = vi.fn()
  let disposed = false
  const host: TuiHost & { reattach?: unknown; setSessionId?: unknown } = {
    send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
      if (disposed) return { ok: false, error: '通道已销毁', code: 'DISPOSED' }
      calls.push(cmd.op)
      if (cmd.op === 'session/new' && failSessionNew) return { ok: false, error: '命令通道不可达：ECONNREFUSED', code: 'NETWORK' }
      return { ok: false, error: '命令通道不可达：ECONNREFUSED', code: 'NETWORK' }
    },
    subscribe: () => () => {},
    dispose: () => {
      disposed = true
    },
    ...({ reattach, setSessionId } as never),
  }
  return { host, reattach, setSessionId, calls }
}

describe('TUI 稳定性：daemon 失联自愈链', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
    resurrectMock.mockReset()
  })
  afterEach(() => cleanup())

  it('路径①：prompt NETWORK → 重拉成功 → reattach + 会话冷拉回 → 原 prompt 重试成功（关键命令全序）', async () => {
    resurrectMock.mockResolvedValue({ id: 'i9', port: 45678, token: 'tk9', pid: process.pid, version: '0.1.0' })
    const calls: Array<{ op: string; sid?: string }> = []
    const lines: HistoryLine[] = []
    const reattach = vi.fn()
    const setSessionId = vi.fn()
    let prompts = 0
    const host: TuiHost & { reattach?: unknown; setSessionId?: unknown } = {
      send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
        if (cmd.op === 'prompt') {
          prompts += 1
          if (prompts === 1) return { ok: false, error: '命令通道不可达：ECONNREFUSED', code: 'NETWORK' }
          lines.push({ role: 'user', content: [{ type: 'text', text: cmd.text }] } as Message)
          return { ok: true, routed: 'Started', sessionId: 's-rescue' }
        }
        if (cmd.op === 'session/read') { calls.push({ op: 'read', sid: cmd.sessionId }); return { ok: true, value: [...lines] } }
        calls.push({ op: cmd.op, sid: (cmd as { sessionId?: string }).sessionId })
        if (cmd.op === 'session/new') return { ok: true, sessionId: 's-rescue' }
        if (cmd.op === 'session/restore') return { ok: true, sessionId: 's-rescue' }
        return { ok: true }
      },
      subscribe: () => () => {},
      dispose: () => {},
      ...({ reattach, setSessionId } as never),
    }
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps() as never, host: host as never }))
    await flush()
    stdin.write('重启后的第一条消息')
    await flush()
    stdin.write('\r')
    await flush(80)
    await vi.waitFor(() => expect(prompts).toBe(2), { timeout: 3000 })
    expect(resurrectMock).toHaveBeenCalledTimes(1)
    expect(reattach).toHaveBeenCalledWith('http://127.0.0.1:45678', 'tk9')
    // 关键命令全序（测试席 P1：全序断言替代弱 toContain）——建会话→首发失败→冷拉回→重读→重试
    const ops = calls.map((c) => c.op)
    expect(ops.indexOf('session/new')).toBeLessThan(ops.indexOf('session/restore'))
    expect(ops.indexOf('session/restore')).toBeLessThan(ops.lastIndexOf('read'))
    // transcript 读面用 daemon 侧真实会话 id（批次 A 修复的守护——测试席 P1）。注：建会话前的
    // 轮首兜底 read 属正常本地语义（attachedSidRef 尚空→Embedded 退回本地 id，失败保旧镜像无害）
    const newIdx = ops.indexOf('session/new')
    expect(calls.filter((c, i) => c.op === 'read' && i > newIdx).every((c) => c.sid === 's-rescue')).toBe(true)
    // 用户输入没丢：echo 已上屏
    expect(lastFrame() ?? '').toContain('重启后的第一条消息')
    expect(lastFrame() ?? '').not.toContain('发送失败')
  })

  it('路径②：首命令失联 → 重拉失败 → 本地降级 → **首条 prompt 走本地宿主**（DISPOSED 语义——审阅 P0-1 回归锁）', async () => {
    resurrectMock.mockResolvedValue(null)
    const dead = makeDeadTransport(true)
    const localLines: HistoryLine[] = []
    const localSend = vi.fn(async (cmd: ProtocolCommand): Promise<CommandResult> => {
      if (cmd.op === 'prompt') {
        localLines.push({ role: 'user', content: [{ type: 'text', text: cmd.text }] } as Message)
        return { ok: true, routed: 'Started' }
      }
      if (cmd.op === 'session/read') return { ok: true, value: [...localLines] }
      return { ok: true }
    })
    const localHost: TuiHost = { send: localSend, subscribe: () => () => {}, dispose: () => {} }
    const localFallback = vi.fn(() => ({
      ...makeDeps(),
      project: { ensureDefault: () => localHost },
    }))
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: makeDeps() as never,
        host: dead.host as never,
        localFallback: localFallback as never,
      }),
    )
    await flush()
    stdin.write('降级后的第一条消息')
    await flush()
    stdin.write('\r')
    await flush(80)
    await vi.waitFor(() => expect(localSend).toHaveBeenCalledWith(expect.objectContaining({ op: 'prompt' })), { timeout: 3000 })
    expect(localFallback).toHaveBeenCalledTimes(1) // 降级装配恰一次（审阅：fake 缺 dispose 语义时此断言暴露双降级）
    expect(lastFrame() ?? '').toContain('降级后的第一条消息') // echo 上屏=发送成功
    expect(lastFrame() ?? '').toContain('本地模式')
  })

  it('路径③：会话已建立后（第二个 prompt）失联 → 降级 → prompt 重试走本地宿主', async () => {
    resurrectMock.mockResolvedValue(null)
    const calls: string[] = []
    let disposed = false
    let prompts = 0
    const deadish: TuiHost & { reattach?: unknown; setSessionId?: unknown } = {
      send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
        if (disposed) return { ok: false, error: '通道已销毁', code: 'DISPOSED' }
        calls.push(cmd.op)
        if (cmd.op === 'session/new') return { ok: true, sessionId: 's-already' } // 首命令正常（会话已建立）
        if (cmd.op === 'prompt') {
          prompts += 1
          if (prompts === 1) return { ok: false, error: '命令通道不可达：ECONNREFUSED', code: 'NETWORK' } // 干着干着 daemon 死了
          return { ok: true, routed: 'Started', sessionId: 's-already' }
        }
        return { ok: true }
      },
      subscribe: () => () => {},
      dispose: () => {
        disposed = true
      },
      ...({ reattach: () => {}, setSessionId: () => {} } as never),
    }
    const localLines: HistoryLine[] = []
    const localSend = vi.fn(async (cmd: ProtocolCommand): Promise<CommandResult> => {
      if (cmd.op === 'prompt') {
        localLines.push({ role: 'user', content: [{ type: 'text', text: cmd.text }] } as Message)
        return { ok: true, routed: 'Started' }
      }
      if (cmd.op === 'session/read') return { ok: true, value: [...localLines] }
      return { ok: true }
    })
    const localHost: TuiHost = { send: localSend, subscribe: () => () => {}, dispose: () => {} }
    const localFallback = vi.fn((sid: string | undefined) => {
      expect(sid).toBe('s-already') // 降级以 daemon 侧会话 id 续写（同 id 同文件）
      return { ...makeDeps(), project: { ensureDefault: () => localHost } }
    })
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, { deps: makeDeps() as never, host: deadish as never, localFallback: localFallback as never }),
    )
    await flush()
    stdin.write('第二条消息')
    await flush()
    stdin.write('\r')
    await flush(80)
    await vi.waitFor(() => expect(localSend).toHaveBeenCalledWith(expect.objectContaining({ op: 'prompt' })), { timeout: 3000 })
    expect(lastFrame() ?? '').toContain('第二条消息')
    expect(lastFrame() ?? '').not.toContain('发送失败')
  })

  it('路径④：附着态挂载期 restore——transport 先切目标 id；失败提示「未切换」不再吞掉', async () => {
    const sidOps: string[] = []
    const setSessionId = vi.fn((sid: string) => {
      sidOps.push(sid)
    })
    const host: TuiHost & { setSessionId?: unknown } = {
      send: async (cmd: ProtocolCommand): Promise<CommandResult> => {
        if (cmd.op === 'session/new') return { ok: true, sessionId: 's-cur' }
        if (cmd.op === 'session/restore') return { ok: false, error: '会话不存在或不属于当前项目：s-target', code: 'SESSION_NOT_FOUND' }
        if (cmd.op === 'session/read') return { ok: true, value: [] as HistoryLine[] }
        return { ok: true }
      },
      subscribe: () => () => {},
      dispose: () => {},
      ...({ setSessionId } as never),
    }
    const { lastFrame } = render(
      React.createElement(TuiApp, { deps: makeDeps() as never, host: host as never, initialHistorySessionId: 's-target' }),
    )
    await flush(80)
    // 发送前 transport 已先切目标 id（防信封旧 id 错路由——restoreSession 前置切换）
    expect(sidOps[0]).toBe('s-target')
    // 失败如实提示（不静默、不半切换）
    expect(lastFrame() ?? '').toContain('恢复失败')
    expect(lastFrame() ?? '').toContain('未切换')
  })
})
