/**
 * ModelPicker 测试（Select 适配壳）。
 * 交互逻辑（↑↓/回车/Esc/环绕）已下沉到 Select 层（见 Select.test.tsx），
 * 这里只验证适配：label 格式 + active 判定 + 选中回调传 ModelEntry。
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ModelPicker, type ModelEntry } from '../../src/tui/ModelPicker.js'

const entries: ModelEntry[] = [
  { name: 'astron', model: 'glm-5.2' },
  { name: 'deepseek', model: 'deepseek-v4-pro' },
]

describe('ModelPicker（Select 适配壳）', () => {
  it('渲染 title + 所有 entry + 当前标记', () => {
    const { lastFrame } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'astron', model: 'glm-5.2' },
        onPick: () => {},
        onCancel: () => {},
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('切换供应商/模型')
    expect(f).toContain('astron')
    expect(f).toContain('glm-5.2')
    expect(f).toContain('deepseek')
    expect(f).toContain('deepseek-v4-pro')
    expect(f).toContain('当前')
  })

  it('初始光标在当前项，回车 → onPick(current entry)', () => {
    const onPick = vi.fn()
    const { stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'deepseek', model: 'deepseek-v4-pro' },
        onPick,
        onCancel: () => {},
      }),
    )
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith({ name: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('current 不在列表 → 初始第一项（无 (当前) 标记）', () => {
    const onPick = vi.fn()
    const { lastFrame, stdin } = render(
      React.createElement(ModelPicker, {
        entries,
        current: { name: 'xxx', model: 'yyy' },
        onPick,
        onCancel: () => {},
      }),
    )
    expect(lastFrame() ?? '').not.toContain('当前')
    stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith(entries[0])
  })
})
