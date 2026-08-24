/**
 * M13-B4 子代理超时自总结测试：无临终遗言 → 一次性总结调用抢救（固定格式 prompt/独立限时）；
 * 总结调用自身失败回落报错路径；正常完成路径零改动。
 * 直接测 resumeSummary 语义太绕（函数私有）——经 makeTaskTool execute 驱动，Mock provider
 * 主调用给超时形态（无 done 后 runLoop 正常返回无遗言）、总结调用给文本。
 */

import { describe, expect, it } from 'vitest'
import { makeTaskTool } from '../../src/services/subagent.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool, ToolContext } from '../../src/tools/interface.js'
import type { LLMProvider, LLMProviderRunRequest, ProviderReq } from '../../src/providers/interface.js'
import type { Delta, Message } from '../../src/core/types.js'
import type { Logger } from '../../src/services/logger.js'

/** 双剧本 Mock：call1=子代理主调用（吐工具过程后超时形态——只吐 tool 流不给结论文本）；
 *  call2+=自总结调用（返回固定总结文本）。记请求以断言 prompt 形态。 */
class ScriptedProvider implements LLMProvider {
  readonly type = 'mock'
  call = 0
  readonly requests: LLMProviderRunRequest[] = []
  constructor(private summaryText: string | null) {}
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    this.requests.push(req)
    this.call++
    if (this.call === 1) {
      // 主调用第一轮：只有 tool_use 无 text（超时被断的形态）
      yield { type: 'tool_use_start', id: 't1', name: 'noop' }
      yield { type: 'tool_use_end', id: 't1' }
      yield { type: 'done', stop_reason: 'tool_use' }
      return
    }
    if (this.call === 2) {
      // loop 续轮（tool_result 后）：end 且无 text——lastAssistantText='' 触发自总结
      yield { type: 'done', stop_reason: 'end' }
      return
    }
    // 自总结调用
    if (this.summaryText === null) throw new Error('总结调用也失败')
    yield { type: 'text', text: this.summaryText }
    yield { type: 'done', stop_reason: 'end' }
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const noopTool: Tool = {
  name: 'noop',
  description: 'n',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  async execute() {
    return { content: 'ok' }
  },
}

const makeDeps = (p: LLMProvider) => ({
  getProviderReq: (): ProviderReq => ({ name: 'm', baseURL: 'http://x', apiKey: 'sk', model: 'm' }),
  getProvider: () => p,
  logger: noopLogger,
  makeAfterTools: () => async () => undefined,
  onBeforeWrite: async () => {},
  cwd: process.cwd(),
  registry: (() => {
    const reg = new ToolRegistryImpl()
    reg.register(noopTool)
    return reg
  })(),
  projectInstructions: '',
  getModel: () => 'm',
})

const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal })

describe('M13-B4 子代理超时自总结', () => {
  it('无临终遗言（超时形态）→ 自总结抢救：返回总结文本而非裸报错；总结 prompt 含固定格式', async () => {
    const p = new ScriptedProvider('状态: 已完成排查\n结论: 配置缺 apiKey\n证据位置: config.ts:31\n未确认项: 无\n下一步: 补配置')
    const tool = makeTaskTool(makeDeps(p))
    const r = await tool.execute({ description: '查配置', prompt: '排查配置问题' }, ctx())
    expect(r.is_error).not.toBe(true)
    expect((r.content as string)).toContain('状态: 已完成排查')
    expect((r.content as string)).toContain('自动抢救')
    // 总结调用 prompt 带固定格式五段（requests 序：0=主首轮 1=loop 续轮 2=自总结）
    const summaryReq = p.requests[p.requests.length - 1]
    expect(summaryReq).toBeDefined()
    const text = (summaryReq.messages[0].content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? ''
    expect(text).toContain('状态:')
    expect(text).toContain('未确认项:')
    expect(summaryReq.tools).toEqual([]) // tools 空（一次性调用）
  })

  it('总结调用自身失败 → 回落现状报错路径（is_error，不无限重试）', async () => {
    const p = new ScriptedProvider(null)
    const tool = makeTaskTool(makeDeps(p))
    const r = await tool.execute({ description: '查', prompt: 'x' }, ctx())
    expect(r.is_error).toBe(true)
    expect((r.content as string)).toContain('未产出文本结论')
  })
})
