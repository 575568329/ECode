import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Wizard } from '../../src/tui/Wizard.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('Wizard', () => {
  it('渲染第一步（type Select，含进度）', () => {
    const { lastFrame } = render(React.createElement(Wizard, { onComplete: () => {}, onCancel: () => {} }))
    const f = lastFrame() ?? ''
    expect(f).toContain('协议类型')
    expect(f).toContain('anthropic')
    expect(f).toContain('openai')
    expect(f).toContain('1/5')
  })

  it('完整填表 → onComplete 收集所有值', async () => {
    const onComplete = vi.fn()
    const { stdin } = render(React.createElement(Wizard, { onComplete, onCancel: () => {} }))
    // type（默认 anthropic active）→ 回车选
    stdin.write('\r')
    await flush()
    // baseURL → 输入 + 回车
    stdin.write('http://x')
    await flush()
    stdin.write('\r')
    await flush()
    // apiKey
    stdin.write('sk-c')
    await flush()
    stdin.write('\r')
    await flush()
    // model（逗号分隔）
    stdin.write('glm-5.2, glm-4')
    await flush()
    stdin.write('\r')
    await flush()
    // thinking（默认 medium active）→ 回车选 → onComplete
    stdin.write('\r')
    await flush()
    expect(onComplete).toHaveBeenCalledWith({
      type: 'anthropic',
      baseURL: 'http://x',
      apiKey: 'sk-c',
      models: 'glm-5.2, glm-4',
      thinking: 'medium',
    })
  })

  it('type 步 Esc → onCancel（Select 自身取消）', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(React.createElement(Wizard, { onComplete: () => {}, onCancel }))
    stdin.write('\u001b')
    await flush()
    expect(onCancel).toHaveBeenCalled()
  })

  it('baseURL 步 Esc → onCancel（Wizard 拦截 TextInput 步）', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(React.createElement(Wizard, { onComplete: () => {}, onCancel }))
    stdin.write('\r')
    await flush() // type → baseURL
    stdin.write('\u001b')
    await flush() // Esc
    expect(onCancel).toHaveBeenCalled()
  })

  it('切到 openai → onComplete 含 type:openai', async () => {
    const onComplete = vi.fn()
    const { stdin } = render(React.createElement(Wizard, { onComplete, onCancel: () => {} }))
    // type 步 ↓ 选 openai（默认 anthropic active=第一项，↓ 到第二项）
    stdin.write('\u001b[B')
    await flush()
    stdin.write('\r')
    await flush()
    // baseURL
    stdin.write('http://d')
    await flush()
    stdin.write('\r')
    await flush()
    // apiKey
    stdin.write('k')
    await flush()
    stdin.write('\r')
    await flush()
    // model
    stdin.write('deepseek-v4')
    await flush()
    stdin.write('\r')
    await flush()
    // thinking → 回车（默认 medium）
    stdin.write('\r')
    await flush()
    expect(onComplete.mock.calls[0][0].type).toBe('openai')
    expect(onComplete.mock.calls[0][0].baseURL).toBe('http://d')
  })
})
