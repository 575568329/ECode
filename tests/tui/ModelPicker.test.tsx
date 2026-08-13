import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ModelPicker, type ModelEntry } from '../../src/tui/ModelPicker.js'

const entries: ModelEntry[] = [
  { name: 'astron', model: 'glm-5.2' },
  { name: 'astron', model: 'glm-4-flash' },
  { name: 'deepseek', model: 'deepseek-v4-pro' },
]

/** ↑↓ 方向键 escape sequence（ink-testing-library 经 readline 解析为 key.upArrow/downArrow） */
const UP = '\u001b[A'
const DOWN = '\u001b[B'

/**
 * ink 对 ESC 开头的输入有 ~20ms flush 延迟（等 chunked escape sequence 完成），
 * testing 环境写 escape sequence 后需等 timer 触发再断言。
 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('ModelPicker', () => {
  it('渲染标题/条目/当前标记/提示', () => {
    const { lastFrame } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'astron', model: 'glm-5.2' },
        onPick: () => {},
        onCancel: () => {},
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('切换') // 标题
    expect(f).toContain('astron')
    expect(f).toContain('glm-5.2')
    expect(f).toContain('glm-4-flash')
    expect(f).toContain('deepseek-v4-pro')
    expect(f).toContain('当前') // 当前激活标记
    expect(f).toContain('↑↓') // 操作提示
  })

  it('初始光标在 current，回车 → onPick(current)', () => {
    const onPick = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'astron', model: 'glm-4-flash' }, // 第二项
        onPick,
        onCancel: () => {},
      }),
    )
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith({ name: 'astron', model: 'glm-4-flash' })
  })

  it('↓ 后回车 → onPick 下一项', async () => {
    const onPick = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'astron', model: 'glm-5.2' },
        onPick,
        onCancel: () => {},
      }),
    )
    stdin.write(DOWN)
    await flush()
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith({ name: 'astron', model: 'glm-4-flash' })
  })

  it('↑ 环绕到末尾', async () => {
    const onPick = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'astron', model: 'glm-5.2' }, // 第一项
        onPick,
        onCancel: () => {},
      }),
    )
    stdin.write(UP) // 第一项再 ↑ → 环绕到末尾
    await flush()
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith({ name: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('↓ 环绕到开头', async () => {
    const onPick = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'deepseek', model: 'deepseek-v4-pro' }, // 末项
        onPick,
        onCancel: () => {},
      }),
    )
    stdin.write(DOWN) // 末项再 ↓ → 环绕到开头
    await flush()
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith({ name: 'astron', model: 'glm-5.2' })
  })

  it('Esc → onCancel', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'astron', model: 'glm-5.2' },
        onPick: () => {},
        onCancel,
      }),
    )
    stdin.write('\u001b') // Esc
    await flush()
    expect(onCancel).toHaveBeenCalled()
  })

  it('current 不在列表 → 初始光标回退第一项', () => {
    const onPick = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'xxx', model: 'yyy' }, // 不存在
        onPick,
        onCancel: () => {},
      }),
    )
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith(entries[0])
  })
})
