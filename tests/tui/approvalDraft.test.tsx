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

describe('P1-1③：TuiApp 审批草稿桥（handleConfirmDraftKey 三分支 + 应答后行为）', () => {
  it('字符经 insert 通道可见回显；BS 删尾；Enter 提交走插话队列（已排队提示）', async () => {
    const provider = new ApprovalProvider()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(provider) }))
    await flush()
    stdin.write('帮我写入')
    await flush()
    stdin.write('\r')
    await flush(500)
    // 审批卡弹出
    expect(lastFrame() ?? '').toContain('[y] 执行')
    // ① 字符不吞：打 abc → 输入框回显（经 insert 通道写主输入框）
    stdin.write('abc')
    await flush()
    expect(lastFrame() ?? '').toContain('abc')
    // 卡仍在（打字不消卡）
    expect(lastFrame() ?? '').toContain('[y] 执行')
    // ② BS 删尾：退两格 → 只剩 a
    stdin.write('\x7f')
    stdin.write('\x7f')
    await flush()
    const f2 = lastFrame() ?? ''
    expect(f2).not.toContain('abc')
    expect(f2).toContain('[y] 执行') // 卡仍在
    // ③ 再补字后 Enter → 插话排队（running=true 走 enqueueInterject）
    stdin.write('bc')
    await flush()
    stdin.write('\r')
    await flush(600)
    const f3 = lastFrame() ?? ''
    expect(f3).toContain('已排队') // 走插话队列（非新轮）
    expect(f3).toContain('[y] 执行') // 卡不消不误批
  })

  it('应答（y 放行）后输入框草稿清空——后续按键正常进输入框', async () => {
    const provider = new ApprovalProvider()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(provider) }))
    await flush()
    stdin.write('帮我写入')
    await flush()
    stdin.write('\r')
    await flush(500)
    expect(lastFrame() ?? '').toContain('[y] 执行')
    stdin.write('draft')
    await flush()
    expect(lastFrame() ?? '').toContain('draft')
    // 放行路径：草稿非空时 y 已让位（②语义），走④显式选择——→ 选中 y + Enter 确认。
    // （不用「清空草稿再 y」——退格逐发在负载下仍可能被吞残留草稿，显式选择无此依赖）
    stdin.write('\x1b[C') // → 显式选中 y
    await flush()
    stdin.write('\r')
    await flush(800)
    const f = lastFrame() ?? ''
    expect(f).not.toContain('[y] 执行') // 卡消（放行）
    expect(f).toContain('写入收尾') // 工具执行后收尾
    // 应答清草稿：输入框为空（帧上无 draft 残留）
    expect(f).not.toContain('draft')
  })

  it('卡弹出前 busy 输入框已有的字成为草稿基线（P1-1(a)）：后续打字追加而非覆写', async () => {
    const provider = new ApprovalProvider()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(provider) }))
    await flush()
    stdin.write('帮我写入')
    await flush()
    stdin.write('\r')
    // 轮已起（busy）：继续打 abc（InputStream busy 仍激活——进输入框）
    stdin.write('abc')
    await flush(400)
    // 审批卡弹出（此时输入框已有 abc）
    expect(lastFrame() ?? '').toContain('[y] 执行')
    expect(lastFrame() ?? '').toContain('abc') // abc 可见保留
    // 卡开时打 d → 追加成 abcd（修复前从空草稿起步覆写为 d——abc 丢失）
    stdin.write('d')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('abcd')
    expect(f).not.toMatch(/❯ d\b/) // 不是覆写后的孤立 d
    expect(f).toContain('[y] 执行')
  })

  it('②桥级锁：草稿非空时 y 进草稿不快捷批准（镜像同步 onDraftChange 生效的回归锁）', async () => {
    const provider = new ApprovalProvider()
    const { stdin, lastFrame } = render(React.createElement(TuiApp, { deps: makeDeps(provider) }))
    await flush()
    stdin.write('帮我写入')
    await flush()
    stdin.write('\r')
    await flush(500)
    expect(lastFrame() ?? '').toContain('[y] 执行')
    // 打 s、w 草稿（非快捷字符，逐键发——ink 多字符单发的事件拆分语义不依赖）后再按 y：
    // hasDraft=true（经 onDraftChange 镜像）→ y 让位进草稿。
    // 注意草稿首字符不能是 y——空草稿按 y 是立即快捷批准（§13.8 裁决保留的老习惯语义）
    stdin.write('s')
    await flush()
    stdin.write('w')
    await flush()
    stdin.write('y')
    await flush(600)
    const f = lastFrame() ?? ''
    expect(f).toContain('[y] 执行') // 卡仍在（y 没触发快捷批准）
    expect(f).toContain('swy') // y 作为草稿字符追加（可见）
    expect(f).not.toContain('写入收尾') // 工具未被放行
  })
})
