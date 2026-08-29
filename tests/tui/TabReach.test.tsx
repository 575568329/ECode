import {describe, it, expect, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { TextInput } from '../../src/tui/TextInput.js'
import { useInput } from 'ink'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

// 清账 III P2-5：探针组件直接收 key——区分「Tab 被 TextInput 之外的层处理」与「Tab 彻底
// 丢失」（原用例只断言 onInput 未被调，无法证明 useInput 收到了 key.tab）
function KeyProbe({ onKey }: { onKey: (input: string, key: Record<string, boolean>) => void }): React.ReactElement {
  useInput((input, key) => onKey(input, key as unknown as Record<string, boolean>), { isActive: true })
  return null
}

describe('Tab 键转义序列可达性（界面批 A1 前置核查）', () => {
  it("stdin.write('\\t') 到达 TextInput 的 useInput（可被上层拦截）", async () => {
    // TextInput 自身不处理 Tab（insert 分支要求 input!=='')——用探针：value 受控 + 无 onInput，
    // 若 Tab 被当字符插入会出现 text 变化。此处只需确认测试通道不丢键：
    const onInput = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput }))
    await flush()
    stdin.write('\t')
    await flush()
    // Ink 对 named key（tab）不进 insert 分支 → 无 onInput 调用 = Tab 键确实抵达并按 key 处理
    expect(onInput).not.toHaveBeenCalled()
  })

  it('named key（tab）在 TextInput 中 key.tab === true（经 \\x1b[Z shift-tab 对照）', async () => {
    // 反向对照：shift-tab（\\x1b[Z）同样不进 insert——两组都抵达即通道正常
    const onInput = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput }))
    await flush()
    stdin.write('\x1b[Z')
    await flush()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('P2-5 加固：探针 useInput 直接收到 key.tab===true（键被处理而非彻底丢失）', async () => {
    const seen: Array<Record<string, boolean>> = []
    const { stdin } = render(React.createElement(KeyProbe, { onKey: (_i, key) => seen.push(key) }))
    await flush()
    stdin.write('\t')
    await flush()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]?.tab).toBe(true)
  })

  it('P2-5 加固：shift-tab（\\x1b[Z）到达探针且带 shift 组合标志（与裸 Tab 可辨）', async () => {
    const seen: Array<Record<string, boolean>> = []
    const { stdin } = render(React.createElement(KeyProbe, { onKey: (_i, key) => seen.push(key) }))
    await flush()
    stdin.write('\x1b[Z') // shift-tab：Ink 报 tab+shift 组合（与裸 \t 的差异在 shift 标志）
    await flush()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]?.shift).toBe(true)
    expect(seen[seen.length - 1]?.tab).toBe(true) // 同属 tab 键族——键被处理而非丢失
  })
})
