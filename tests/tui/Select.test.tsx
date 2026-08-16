import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Select, type SelectItem } from '../../src/tui/Select.js'

const items: SelectItem<string>[] = [
  { label: 'astron / glm-5.2', value: 'glm-5.2' },
  { label: 'astron / glm-4-flash', value: 'glm-4-flash' },
  { label: 'deepseek / deepseek-v4-pro', value: 'deepseek-v4-pro' },
]

const UP = '\u001b[A'
const DOWN = '\u001b[B'
/** ink 对 ESC 输入有 ~20ms flush 延迟，testing 要 await 再断言（见 ink-testing-escape-flush 记忆） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('Select', () => {
  it('渲染 title/items/active标记/提示', () => {
    const { lastFrame } = render(
      React.createElement(Select, {
        title: '选一个',
        items: [
          { label: 'a', value: 'a', active: true },
          { label: 'b', value: 'b' },
        ],
        onSelect: () => {},
        onCancel: () => {},
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('选一个')
    expect(f).toContain('a')
    expect(f).toContain('b')
    expect(f).toContain('当前')
    expect(f).toContain('↑↓')
  })

  it('无 title → 不报错（items 正常渲染）', () => {
    const { lastFrame } = render(
      React.createElement(Select, { items, onSelect: () => {}, onCancel: () => {} }),
    )
    expect(lastFrame() ?? '').toContain('glm-5.2')
  })

  it('初始光标在 active 项，回车 → onSelect(active value)', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(Select, {
        items: [
          { label: 'a', value: 'a' },
          { label: 'b', value: 'b', active: true },
        ],
        onSelect,
        onCancel: () => {},
      }),
    )
    stdin.write('\r')
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('无 active → 初始第一项', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(Select, { items, onSelect, onCancel: () => {} }),
    )
    stdin.write('\r')
    expect(onSelect).toHaveBeenCalledWith('glm-5.2')
  })

  it('↓ 后回车 → 下一项', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(Select, { items, onSelect, onCancel: () => {} }),
    )
    stdin.write(DOWN)
    await flush()
    stdin.write('\r')
    expect(onSelect).toHaveBeenCalledWith('glm-4-flash')
  })

  it('↑ 环绕到末尾', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(Select, { items, onSelect, onCancel: () => {} }),
    )
    stdin.write(UP)
    await flush()
    stdin.write('\r')
    expect(onSelect).toHaveBeenCalledWith('deepseek-v4-pro')
  })

  it('↓ 环绕到开头', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(Select, { items, onSelect, onCancel: () => {} }),
    )
    stdin.write(UP) // 第一项 → 末项
    await flush()
    stdin.write(DOWN) // 末项 → 开头
    await flush()
    stdin.write('\r')
    expect(onSelect).toHaveBeenCalledWith('glm-5.2')
  })

  it('Esc → onCancel', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(
      React.createElement(Select, { items, onSelect: () => {}, onCancel }),
    )
    stdin.write('\u001b')
    await flush()
    expect(onCancel).toHaveBeenCalled()
  })

  it('空列表 → 显示 emptyHint + Esc 返回（不崩）', async () => {
    const onCancel = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(Select, {
        items: [],
        emptyHint: '无历史会话',
        onSelect: () => {},
        onCancel,
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('无历史会话')
    expect(f).toContain('Esc 返回')
    expect(f).not.toContain('↑↓选择')
    // 回车不触发 onSelect（空态忽略）
    stdin.write('\r')
    // Esc 取消
    stdin.write('\u001b')
    await flush()
    expect(onCancel).toHaveBeenCalled()
  })

  // 窗口化：动态区 outputHeight ≥ 视口行数触发 Ink fullscreen（视角顶到顶部、scrollback 被清），
  // 长列表（/history 会话多）必须封顶可见窗口
  it('超长列表窗口化：仅渲染 12 项窗口 + 溢出计数', () => {
    const many: SelectItem<number>[] = Array.from({ length: 20 }, (_, i) => ({
      label: `s${String(i).padStart(2, '0')}`,
      value: i,
    }))
    const { lastFrame } = render(
      React.createElement(Select, { items: many, onSelect: () => {}, onCancel: () => {} }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('s00')
    expect(f).toContain('s11') // 第 12 项（窗口 0-11）
    expect(f).not.toContain('s12') // 第 13 项不渲染
    expect(f).toContain('↓ 还有 8 项')
    expect(f).not.toContain('↑ 还有')
  })

  it('↓ 导航后窗口跟随（光标居中）+ 上方溢出计数', async () => {
    const many: SelectItem<number>[] = Array.from({ length: 20 }, (_, i) => ({
      label: `s${String(i).padStart(2, '0')}`,
      value: i,
    }))
    const { stdin, lastFrame } = render(
      React.createElement(Select, { items: many, onSelect: () => {}, onCancel: () => {} }),
    )
    for (let i = 0; i < 7; i++) {
      stdin.write(DOWN)
      await flush()
    } // idx=7 → 窗口起点 1（光标居中）
    const f = lastFrame() ?? ''
    expect(f).toContain('s01') // 滚入窗口首行
    expect(f).not.toContain('s00') // 滚出窗口
    expect(f).toContain('↑ 还有 1 项')
    expect(f).toContain('↓ 还有 7 项')
  })
})
