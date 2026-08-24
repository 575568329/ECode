/**
 * M13-B3 roles.summary 分流测试（方案 §10 B 线分项）：
 * 配置 → 压缩调用落到指定 provider+model；未配置回退主模型；provider 名缺失启动报错；
 * 窗口下限（SUMMARY_WINDOW_FLOOR 常量反算）不足 → 装配层拒绝分流回退。
 */

import { describe, expect, it } from 'vitest'
import { makeOnBeforeRequest } from '../../../src/services/compaction/hook.js'
import { CompactionOrchestrator } from '../../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../../src/services/compaction/summarize.js'
import { SUMMARY_WINDOW_FLOOR } from '../../../src/services/compaction/summarize.js'
import type { LLMProvider, LLMProviderRunRequest, ProviderReq } from '../../../src/providers/interface.js'
import type { Delta, HistoryLine, Message } from '../../../src/core/types.js'
import { loadConfig } from '../../../src/services/config.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 记录型 Mock：记下每次请求的 model（断言分流落点） */
class RecordingProvider implements LLMProvider {
  readonly type: string
  readonly calls: string[] = []
  constructor(type: string, private readonly asModel: string) {
    this.type = type
  }
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    this.calls.push(req.model)
    void this.asModel
    yield { type: 'text', text: '摘要内容：用户做了 A 和 B。' }
    yield { type: 'done', stop_reason: 'end' }
  }
}

const req = (model: string, contextWindow?: number): ProviderReq => ({
  name: 'x', baseURL: 'http://x', apiKey: 'sk', model, ...(contextWindow !== undefined ? { contextWindow } : {}),
})

/** 造一段足以触发 pressure 的对话（估算超阈：system 长 + 消息多） */
const bigConversation = (): HistoryLine[] => {
  const lines: HistoryLine[] = []
  for (let i = 0; i < 30; i++) {
    lines.push({ role: 'user', content: [{ type: 'text', text: `问题 ${i}：`.padEnd(600, '详') }] })
    lines.push({ role: 'assistant', content: [{ type: 'text', text: `回答 ${i}：`.padEnd(600, '详') }] })
  }
  return lines
}

const runOnce = async (
  summary: { provider: LLMProvider; providerReq: ProviderReq; window: number } | undefined,
): Promise<void> => {
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const main = new RecordingProvider('mock', 'm')
  const hook = makeOnBeforeRequest(orch, main, req('glm-5.2', 4000), '', {
    onCompacted: () => {},
    ...(summary !== undefined ? { summary } : {}),
  })
  await hook(bigConversation(), 'pressure')
}

describe('M13-B3 roles.summary 分流', () => {
  it('配置 summary → 摘要调用落到指定 model（换笔生效）', async () => {
    const summaryProvider = new RecordingProvider('mock', 's')
    await runOnce({ provider: summaryProvider, providerReq: req('glm-4.6-flash', 128000), window: 115200 })
    expect(summaryProvider.calls.length).toBeGreaterThan(0)
    expect(summaryProvider.calls.every((m) => m === 'glm-4.6-flash')).toBe(true)
  })

  it('未配置 summary → 摘要走主模型（现状回退）', async () => {
    // 主模型作为 summary 传 undefined；RecordingProvider 记录的是主 provider 的调用
    const orch = new CompactionOrchestrator()
    orch.register(new SummarizeStrategy())
    const main = new RecordingProvider('mock', 'm')
    const hook = makeOnBeforeRequest(orch, main, req('glm-5.2', 4000), '', { onCompacted: () => {} })
    await hook(bigConversation(), 'pressure')
    expect(main.calls.length).toBeGreaterThan(0)
    expect(main.calls.every((m) => m === 'glm-5.2')).toBe(true)
  })

  it('SUMMARY_WINDOW_FLOOR = 批预算常量反算 2 倍（20000+4096+8000+1500=33596 → 67192）', () => {
    expect(SUMMARY_WINDOW_FLOOR).toBe(67192)
  })
})

describe('M13-B3 loadConfig 校验', () => {
  it('roles.summary.provider 不存在于 providers → 启动报配置错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-roles-cfg-'))
    const cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({
      providers: { main: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
      default: { provider: 'main', model: 'm' },
      roles: { summary: { provider: '不存在的', model: 'f' } },
    }))
    // HOME 重定向到临时目录（禁碰真实 ~/.ecode——记忆铁律）
    const home = process.env.HOME
    process.env.HOME = dir
    try {
      expect(() => loadConfig({ configPath: cfgPath, noEnv: true })).toThrow('CONFIG_ROLES_INVALID')
    } finally {
      if (home !== undefined) process.env.HOME = home
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
