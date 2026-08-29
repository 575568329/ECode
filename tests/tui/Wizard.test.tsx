import {describe, it, expect, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { Wizard } from '../../src/tui/Wizard.js'
import type { ProviderCfg } from '../../src/services/config.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const astronCfg: ProviderCfg = {
  type: 'anthropic',
  baseURL: 'http://a',
  apiKey: 'sk-a',
  models: ['glm-5.2'],
  thinking: 'medium',
}

describe('Wizard · 首次（无现有 provider）', () => {
  it('第一步直接 type Select（跳过 mode，5 步）', () => {
    const { lastFrame } = render(React.createElement(Wizard, { onComplete: () => {}, onCancel: () => {} }))
    const f = lastFrame() ?? ''
    expect(f).toContain('协议类型')
    expect(f).toContain('1/5') // 5 步（无 mode/name）
    expect(f).not.toContain('配置向导') // mode 步标题是「配置向导」，首次不该有
  })

  it('完整填表 → onComplete（mode=add, providerName=default）', async () => {
    const onComplete = vi.fn()
    const { stdin } = render(React.createElement(Wizard, { onComplete, onCancel: () => {} }))
    stdin.write('\r'); await flush() // type（默认 anthropic）
    stdin.write('http://x'); await flush(); stdin.write('\r'); await flush() // baseURL
    stdin.write('sk-c'); await flush(); stdin.write('\r'); await flush() // apiKey
    stdin.write('glm-5.2, glm-4'); await flush(); stdin.write('\r'); await flush() // model
    stdin.write('\r'); await flush() // thinking（默认 medium）
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'add',
      providerName: 'default',
      type: 'anthropic',
      baseURL: 'http://x',
      apiKey: 'sk-c',
      models: 'glm-5.2, glm-4',
      thinking: 'medium',
    })
  })

  it('type 步 Esc → onCancel', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(React.createElement(Wizard, { onComplete: () => {}, onCancel }))
    stdin.write('\u001b'); await flush()
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('Wizard · 有现有 provider', () => {
  const existing = [{ name: 'astron', cfg: astronCfg }]

  it('第一步 mode Select（新增/编辑）', () => {
    const { lastFrame } = render(
      React.createElement(Wizard, { onComplete: () => {}, onCancel: () => {}, existingProviders: existing }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('配置向导')
    expect(f).toContain('新增供应商')
    expect(f).toContain('编辑：astron')
  })

  it('选「编辑 astron」→ 预填值 + 全回车 = 保留原值', async () => {
    const onComplete = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(Wizard, { onComplete, onCancel: () => {}, existingProviders: existing }),
    )
    stdin.write('\u001b[B'); await flush() // ↓ 到「编辑：astron」
    stdin.write('\r'); await flush() // 选编辑
    // 此时应进 type 步（编辑跳过 name），预填 anthropic active
    expect(lastFrame() ?? '').toContain('协议类型')
    // 全回车跳过所有步（保留预填值）
    stdin.write('\r'); await flush() // type
    stdin.write('\r'); await flush() // baseURL（预填 http://a）
    stdin.write('\r'); await flush() // apiKey（预填 sk-a）
    stdin.write('\r'); await flush() // model（预填 glm-5.2）
    stdin.write('\r'); await flush() // thinking（预填 medium）
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'edit',
      providerName: 'astron',
      type: 'anthropic',
      baseURL: 'http://a',
      apiKey: 'sk-a',
      models: 'glm-5.2',
      thinking: 'medium',
    })
  })

  it('选「新增」→ 进 name 步输入标识', async () => {
    const onComplete = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(Wizard, { onComplete, onCancel: () => {}, existingProviders: existing }),
    )
    stdin.write('\r'); await flush() // 选「新增供应商」（默认第一项）
    // 进 name 步
    expect(lastFrame() ?? '').toContain('供应商名称')
    stdin.write('deepseek'); await flush(); stdin.write('\r'); await flush()
    stdin.write('\r'); await flush() // type 默认 anthropic
    stdin.write('http://d'); await flush(); stdin.write('\r'); await flush()
    stdin.write('k'); await flush(); stdin.write('\r'); await flush()
    stdin.write('ds-v4'); await flush(); stdin.write('\r'); await flush()
    stdin.write('\r'); await flush() // thinking 默认 medium
    expect(onComplete.mock.calls[0][0]).toMatchObject({ mode: 'add', providerName: 'deepseek', baseURL: 'http://d' })
  })
})
