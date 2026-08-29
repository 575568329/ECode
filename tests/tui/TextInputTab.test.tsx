import {describe, it, expect, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { TextInput } from '../../src/tui/TextInput.js'
import { createCursor } from '../../src/tui/cursor.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('Tab 键不进输入框（M9-D13：Tab 专职沙箱档位——无任何编辑职责）', () => {
  it('普通输入态按 Tab：不插入制表符（修复前 insert \t）', async () => {
    const onInput = vi.fn()
    const { stdin } = render(
      React.createElement(TextInput, { value: '', caret: 0, onInput }),
    )
    await flush()
    stdin.write('ab')
    await flush()
    stdin.write('\t')
    await flush()
    // Ink 7 对 named key（tab）input=''——insert 分支不触发；ab 一次 write 粘连为单次回调（M6 已知行为）
    const texts = onInput.mock.calls.map((c) => (c[0] as { text: string }).text)
    expect(texts).toEqual(['ab']) // 若 Tab 泄漏会追加 'ab\t'
  })

  it('斜杠补全态按 Tab：不补全也不插字符（输入保持原样）', async () => {
    const onInput = vi.fn()
    const { stdin } = render(
      React.createElement(TextInput, { value: '/comm', caret: 5, onInput }),
    )
    await flush()
    stdin.write('\t')
    await flush()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('cursor 辅助：createCursor 初始态', () => {
    const c = createCursor('')
    expect(c.text).toBe('')
    expect(c.caret).toBe(0)
  })
})
