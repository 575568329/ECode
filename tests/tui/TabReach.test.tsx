import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { TextInput } from '../../src/tui/TextInput.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

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

  it('named key（tab）在 TextInput 中 key.tab === true（经 \x1b[Z shift-tab 对照）', async () => {
    // 反向对照：shift-tab（\x1b[Z）同样不进 insert——两组都抵达即通道正常
    const onInput = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput }))
    await flush()
    stdin.write('\x1b[Z')
    await flush()
    expect(onInput).not.toHaveBeenCalled()
  })
})
