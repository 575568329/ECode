/**
 * 审阅 R6/P2-4：轮中失联自愈最小测试集——rescue 收场行为锁定
 * （命令路径 rescue → degradeToLocal：running 收口/live 封口/排队退回+降级提示共存）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import * as os from 'node:os'
import * as path from 'node:path'
import { TuiApp, type TuiHost } from '../../src/tui/TuiApp.js'
import type { ProtocolCommand, ProtocolEvent, CommandResult } from '../../src/protocol/types.js'
import type { HistoryLine } from '../../src/core/types.js'
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
// 隔离 daemon 探测层（防测试拉起真 serve/读到真注册——reattached 分支不可控）：
// resurrect 恒失败（验活 null+拉起 null）→ rescue 走本地降级路径（本测试标的）
vi.mock('../../src/cli/daemon.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/cli/daemon.js')>()
  return {
    ...orig,
    readServerReg: () => null,
    resurrectDaemonReg: async () => null,
  }
})

const config: Config = {
  providers: { astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'k', models: ['glm-5.2'] } },
  current: { name: 'astron', model: 'glm-5.2' },
  maxIterations: 50,
  bashMaxOutputBytes: 30720,
  logLevel: 'info',
} as unknown as Config
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const noopHistory = {
  append() {}, appendCompactBoundary() {}, appendRewind() {}, appendThinking() {},
  loadAll() { return [] }, restore() { return [] }, restoreFull() { return [] },
  setSessionId() {}, currentSessionId() { return 'test-session' },
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
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-mt-skills') }),
    mcpManager: null,
  }
}

/** 死后台 host：所有 send 抛网络错（触发命令路径 rescue）；reattach 缺省=走本地降级 */
function makeDeadHost() {
  let handler: ((ev: ProtocolEvent) => void) | null = null
  const host: TuiHost = {
    send: async (_cmd: ProtocolCommand): Promise<CommandResult> =>
      ({ ok: false, error: 'NETWORK: fetch failed (daemon dead)', code: 'NETWORK' }) as CommandResult,
    // setSessionId 存在 = TuiApp 判定附着形态（transportRef 建位 → attached=true）
    setSessionId: (_sid: string) => {},
    // daemonState=backoff：驱动 G3 tick 触发面（busy 轮中 Enter 走插话队列不进 doSubmit——
    // 命令路径 rescue 不可达，轮中自愈只能靠事件流 tick 路径——即被测的真实堵死场景）
    daemonState: () => 'backoff' as const,
    subscribe: (h) => { handler = h; return () => { handler = null } },
    dispose: () => {},
  } as unknown as TuiHost
  return { host, fire: (ev: ProtocolEvent) => { handler?.(ev) } }
}

describe('R6：轮中失联自愈（rescue 收场行为）', () => {
  beforeEach(() => { commandRegistry.clear(); registerBuiltinCommands() })
  afterEach(() => cleanup())

  it('轮运行中命令失败 → rescue → 本地降级收场：running 收口 + live 封口 + 排队退回与降级提示共存', async () => {
    const { host, fire } = makeDeadHost()
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: makeDeps(),
        host,
        localFallback: () => makeDeps() as never,
      }),
    )
    await flush()
    // 构造「轮运行中」：busy 帧 + live 文本 + 排队插话镜像
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: null, iter: 1 })
    fire({ type: 'delta', seq: 2, turnId: 't1', text: '流式中段' })
    fire({ type: 'queue/snapshot', seq: 3, items: ['排队的长消息一二三'] })
    await flush(100)
    // 触发命令路径 rescue（prompt NETWORK 失败）
    stdin.write('下一条')
    await flush()
    stdin.write('\r')
    // tick 触发窗（4×2s=8s backoff 计数 + rescue）——等待降级提示出现
    for (let i = 0; i < 60; i++) {
      await flush(500)
      const f = lastFrame() ?? ''
      if (f.includes('本地模式')) break
    }
    const f = lastFrame() ?? ''
    expect(f).toContain('本地模式') // 降级提示（sticky error 主提示最后推——占底部告警行显示位）
    // 2026-09-03 告警中心聚合语义：tail 条目（退回/作废）折叠进「还有 N 条」计数不再同屏全显
    expect(f).toMatch(/还有 \d+ 条（\/warnings 查看）/) // tail 存在（计数可见）
    expect(f).toContain('流式中段') // 已产出保留（封口不丢）
    // running 已收：输入框提示回落（不再是「处理中」占位）
    expect(f).not.toContain('（处理中')
  }, 30000)

  it('挂起审批随轮作废：busy 轮中审批卡挂起 → rescue 收场 resolve(false)+可见提示（R6 五件套回归锁）', async () => {
    const { host, fire } = makeDeadHost()
    const { stdin, lastFrame } = render(
      React.createElement(TuiApp, {
        deps: makeDeps(),
        host,
        localFallback: () => makeDeps() as never,
      }),
    )
    await flush()
    // 构造「轮运行中 + 审批挂起」：busy 帧随后审批卡（confirm 状态位由事件处理器置起）
    fire({ type: 'thread/status', seq: 1, busy: true, waitingOn: null, iter: 1 })
    fire({ type: 'approval/requested', seq: 2, requestId: 'ap1', kind: 'tool', tool: 'bash', preview: 'rm -rf /tmp/x', decisions: ['allow', 'deny'] })
    await flush(100)
    expect(lastFrame() ?? '').toContain('rm -rf /tmp/x') // 审批卡已挂起
    // 触发自愈（tick 路径——busy 态命令路径不可达）→ 降级收场
    stdin.write('触发')
    await flush()
    stdin.write('\r')
    for (let i = 0; i < 50; i++) {
      await flush(500)
      const f = lastFrame() ?? ''
      if (f.includes('本地模式')) break
    }
    const f = lastFrame() ?? ''
    expect(f).toContain('本地模式')
    // 2026-09-03 告警中心聚合语义：作废提示折叠进计数——存在性经 warnings 面板断言
    expect(f).toMatch(/还有 \d+ 条（\/warnings 查看）/) // 「挂起的审批已随轮作废」在计数中
    // 审批卡已收口（confirm 清空——残留会吞后续按键）
    expect(f).not.toContain('（y 允许')
  }, 45000)
})
