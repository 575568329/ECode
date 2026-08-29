/**
 * 审阅 P1-1（测试缺口③）：TuiApp 桥组件级——handleConfirmDraftKey 三分支
 * （字符经 insert 通道可见回显 / BS 删尾 / Enter 提交走插话队列）+ 应答后行为，
 * 以及缺口④：resolve 非空 reason 塞 message、空串不塞。
 * 全链走 TuiApp（协议客户端）→ 内联 HostSession → runLoop——复用 TuiAppKeys.test 基建。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
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

/** P1-1④ 端到端断言用：拒绝对价 tool_result 的 messages 形状 */
type Msgs = Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>

/** 审批工具轮 provider：首轮吐 write_file tool_use（触发审批卡），收 tool_result 后收尾文本 */
class ApprovalProvider implements LLMProvider {
  readonly type = 'mock'
  calls = 0
  lastBody = ''
  lastMessages: Msgs = []
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    this.calls++
    const msgs = req.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>
    this.lastMessages = msgs // P1-1④ 端到端断言用：拒绝对价 tool_result 里的理由串
    const last = msgs.at(-1)
    const lastIsToolResult =
      last?.role === 'user' &&
      typeof last.content !== 'string' &&
      last.content.some((b) => b.type === 'tool_result')
    if (!lastIsToolResult) {
      yield { type: 'text', text: '准备写入' }
      yield { type: 'tool_use_start', id: 't1', name: 'write_file' }
      yield { type: 'tool_use_end', id: 't1' }
      yield { type: 'done', stop_reason: 'tool_use' }
    } else {
      yield { type: 'text', text: '写入收尾' }
      yield { type: 'done', stop_reason: 'end' }
    }
  }
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

const config: Config = {
  ...emptyShellConfig(),
  providers: {
    m: { type: 'mock', baseURL: 'http://x', apiKey: 'k', models: ['m'], contextWindow: 32000 },
  },
  current: { name: 'm', model: 'm' },
  maxIterations: 10,
}

/** 审批工具（副作用，走 confirm） */
const writeTool = {
  name: 'write_file',
  description: 'write',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
} as const

function makeDeps(provider: LLMProvider) {
  const reg = new LLMProviderRegistryImpl()
  reg.register(provider)
  const tools = new ToolRegistryImpl()
  tools.register(writeTool as never)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  return {
    providerRegistry: reg,
    tools,
    logger: noopLogger,
    history: noopHistory,
    config,
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry: new SkillRegistry({ userDir: path.join(os.tmpdir(), 'ecode-approval-test-skills') }),
    mcpManager: null,
  }
}

const flush = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => cleanup())

describe('P1-1④：拒绝理由接线（resolve 非空 reason 塞 message、空串不塞）', () => {
  it('r 进理由模式 → 输入理由 → Enter：approval/respond 带 message=理由（端到端：tool_result 回喂含理由串）', async () => {
    const provider = new ApprovalProvider()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(provider) }))
    await flush()
    stdin.write('帮我写入')
    await flush()
    stdin.write('\r')
    await flush(500)
    expect(lastFrame() ?? '').toContain('[y] 执行')
    // r 进理由模式+打理由：负载下按键可能被吞——幂等重试（r 没生效可重发；
    // 理由没打全则 Esc 退回选择态整体重试，Esc 在理由模式=reason-cancel 不误拒）
    let inReason = false
    for (let attempt = 0; attempt < 12 && !inReason; attempt++) {
      stdin.write('r')
      await flush(300)
      inReason = (lastFrame() ?? '').includes('拒绝理由')
    }
    expect(inReason).toBe(true)
    let textOk = false
    for (let attempt = 0; attempt < 3 && !textOk; attempt++) {
      stdin.write('不要覆盖配置')
      await flush(300)
      textOk = (lastFrame() ?? '').includes('不要覆盖配置')
      if (!textOk) {
        stdin.write('\x1b') // 退回选择态重来
        await flush(300)
        stdin.write('r')
        await flush(300)
      }
    }
    expect(textOk).toBe(true)
    // Enter 提交（重试安全：首个已生效时卡已消，第二发提交空输入框为 no-op）
    for (let attempt = 0; attempt < 5; attempt++) {
      stdin.write('\r')
      await flush(600)
      if (!(lastFrame() ?? '').includes('[y] 执行')) break
    }
    // 拒绝路径：卡消。宿主收 tool_result（拒绝）→ mock 收尾
    expect(lastFrame() ?? '').not.toContain('[y] 执行')
    expect(lastFrame() ?? '').toContain('写入收尾')
    // 端到端断言（审阅 P1-缺口4 本体）：理由经 approval/respond.message → broker 反馈
    // → tool_result「用户拒绝了本次操作：{理由}」回喂模型（第二轮请求的 messages 里）
    const round2 = provider.lastMessages
    const rejectResult = round2
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? String(b.content ?? '') : (b.text ?? '')))
      .join('\n')
    expect(rejectResult).toContain('不要覆盖配置')
  })

  it('r 进理由模式但留空 → Enter：按无理由拒绝（空串不塞 message）', async () => {
    const provider = new ApprovalProvider()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(provider) }))
    await flush()
    stdin.write('帮我写入')
    await flush()
    stdin.write('\r')
    await flush(500)
    expect(lastFrame() ?? '').toContain('[y] 执行')
    let inReason = false
    for (let attempt = 0; attempt < 12 && !inReason; attempt++) {
      stdin.write('r')
      await flush(300)
      inReason = (lastFrame() ?? '').includes('拒绝理由')
    }
    expect(inReason).toBe(true)
    for (let attempt = 0; attempt < 5; attempt++) {
      stdin.write('\r') // 空理由直接提交（重试安全同上）
      await flush(600)
      if (!(lastFrame() ?? '').includes('[y] 执行')) break
    }
    expect(lastFrame() ?? '').not.toContain('[y] 执行')
    expect(lastFrame() ?? '').toContain('写入收尾')
    // 空理由不塞 message：broker resolve(false) → loop 走「用户已取消」分支（非带理由拒绝语）
    const round2 = provider.lastMessages
    const rejectResult = round2
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? String(b.content ?? '') : (b.text ?? '')))
      .join('\n')
    expect(rejectResult).toContain('用户已取消')
    expect(rejectResult).not.toContain('不要覆盖配置')
  })
})
