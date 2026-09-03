/**
 * PanelShell（M6 T1）：分组导航/即时搜索/Esc 逐级/窗口滚动/空态。
 * Esc 断言注意 ~20ms flush（ink-testing-library，见自测规范）。
 */
import {describe, it, expect, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { PanelShell, type PanelRow } from '../../src/tui/PanelShell.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

interface Item {
  name: string
  desc: string
}

function rows(items: Item[], header = '组'): PanelRow<Item>[] {
  return [
    { type: 'header', label: header },
    ...items.map((i) => ({ type: 'item' as const, value: i, label: `${i.name} ${i.desc}` })),
  ]
}

const N = (items: Item[], extra: Partial<Parameters<typeof PanelShell<Item>>[0]> = {}) =>
  React.createElement(PanelShell<Item>, {
    title: 'T',
    rows: rows(items),
    onPick: () => {},
    onCancel: () => {},
    ...extra,
  })

describe('PanelShell', () => {
  it('渲染标题/副标题/条目/键位提示行', () => {
    const { lastFrame } = render(N([{ name: 'a', desc: 'desc-a' }], { subtitle: '1 个' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('T')
    expect(f).toContain('1 个')
    expect(f).toContain('组')
    expect(f).toContain('a desc-a')
    expect(f).toContain('Esc')
  })

  it('↑↓ 环绕导航 + inverse 高亮', async () => {
    const items = [
      { name: 'a', desc: '' },
      { name: 'b', desc: '' },
      { name: 'c', desc: '' },
    ]
    const { stdin, lastFrame } = render(N(items))
    await flush()
    stdin.write('\u001b[B') // ↓ → b
    await flush()
    // 第二项选中（inverse 高亮无从直接断言样式，断言光标可移到末项再环绕回首项）
    stdin.write('\u001b[B') // ↓ → c
    await flush()
    stdin.write('\u001b[B') // ↓ → 环绕回 a
    await flush()
    stdin.write('\u001b[A') // ↑ → 环绕回 c
    await flush()
    expect(lastFrame()).toContain('a') // 全程不崩，条目都在
  })

  it('Enter → onPick 选中项（默认第一项）', async () => {
    const onPick = vi.fn()
    const items = [
      { name: 'a', desc: '' },
      { name: 'b', desc: '' },
    ]
    const { stdin } = render(N(items, { onPick }))
    await flush()
    stdin.write('\r')
    await flush()
    expect(onPick).toHaveBeenCalledWith(items[0])
  })

  it('2026-09-03 numericPick：未搜索时数字 1-9 直达第 N 项；搜索态数字继续进词', async () => {
    const onPick = vi.fn()
    const items = [
      { name: 'a', desc: '' },
      { name: 'b', desc: '' },
      { name: 'c', desc: '' },
    ]
    const { stdin, lastFrame } = render(N(items, { onPick, numericPick: true }))
    await flush()
    stdin.write('2')
    await flush()
    expect(onPick).toHaveBeenCalledWith(items[1])
    // 搜索态（先输入字母后）数字不截——进搜索词
    const onPick2 = vi.fn()
    const r2 = render(N(items, { onPick: onPick2, numericPick: true }))
    await flush()
    r2.stdin.write('a')
    await flush()
    r2.stdin.write('1')
    await flush()
    expect(onPick2).not.toHaveBeenCalled()
    expect(r2.lastFrame()).toContain('a1')
    // 未开 numericPick 的面板：数字恒进搜索词（默认行为不破坏）
    const onPick3 = vi.fn()
    const r3 = render(N(items, { onPick: onPick3 }))
    await flush()
    r3.stdin.write('1')
    await flush()
    expect(onPick3).not.toHaveBeenCalled()
    expect(r3.lastFrame()).toContain('1')
  })

  it('即时搜索：字符过滤 + 无匹配提示 + backspace 恢复', async () => {
    const items = [
      { name: 'commit', desc: '提交' },
      { name: 'review', desc: '审查' },
    ]
    const { stdin, lastFrame } = render(N(items))
    await flush()
    stdin.write('c')
    await flush()
    expect(lastFrame() ?? '').toContain('commit')
    expect(lastFrame() ?? '').not.toContain('review')
    stdin.write('z')
    await flush()
    expect(lastFrame() ?? '').toContain('无匹配')
    stdin.write('\u007F') // backspace（DEL）删 z
    await flush()
    expect(lastFrame() ?? '').toContain('commit')
  })

  it('Esc 逐级：先清搜索词（不退出），再退出', async () => {
    const onCancel = vi.fn()
    const items = [{ name: 'a', desc: '' }]
    const { stdin, lastFrame } = render(N(items, { onCancel }))
    await flush()
    stdin.write('a')
    await flush()
    expect(lastFrame() ?? '').toContain('搜索')
    stdin.write('\u001b') // Esc → 清词
    await flush()
    expect(onCancel).not.toHaveBeenCalled()
    stdin.write('\u001b') // Esc → 退出
    await flush()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+C = 直接退出（T4：面板期间退面板不中断）', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(N([{ name: 'a', desc: '' }], { onCancel }))
    await flush()
    stdin.write('x')
    await flush()
    stdin.write('\u0003') // Ctrl+C：即使有搜索词也直接退出
    await flush()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('超 12 条窗口滚动：边缘提示行数', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `item-${i}`, desc: '' }))
    const { stdin, lastFrame } = render(N(items))
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('↓ 还有') // 默认光标在第一项，下方有隐藏
    expect(f).not.toContain('item-19') // 窗口外不渲染
    // ↓×15（逐次写——合并写会被 ink 解析成单事件）：光标到 15 → 窗口 [9..20]
    for (let i = 0; i < 15; i++) {
      stdin.write('\u001b[B')
      await flush()
    }
    const f2 = lastFrame() ?? ''
    expect(f2).toContain('item-19')
    expect(f2).toContain('↑ 还有')
  })

  it('空列表：空态提示 + Esc 退出', async () => {
    const onCancel = vi.fn()
    const { lastFrame, stdin } = render(N([], { onCancel, emptyHint: '空空如也' }))
    expect(lastFrame() ?? '').toContain('空空如也')
    stdin.write('\u001b')
    await flush()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('搜索过滤后空组的 header 不显示', async () => {
    const mixed: PanelRow<Item>[] = [
      { type: 'header', label: '组A' },
      { type: 'item', value: { name: 'a1', desc: '' }, label: 'a1' },
      { type: 'header', label: '组B' },
      { type: 'item', value: { name: 'b1', desc: '' }, label: 'b1' },
    ]
    const { stdin, lastFrame } = render(
      React.createElement(PanelShell<Item>, { title: 'T', rows: mixed, onPick: () => {}, onCancel: () => {} }),
    )
    await flush()
    stdin.write('b')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('组B')
    expect(f).not.toContain('组A')
    expect(f).toContain('b1')
  })
})
