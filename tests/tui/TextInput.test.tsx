import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { InputRender, TextInput } from '../../src/tui/TextInput.js'

describe('InputRender', () => {
  it('空文本 + placeholder 显示占位', () => {
    const { lastFrame } = render(
      React.createElement(InputRender, { text: '', caret: 0, placeholder: '输入消息...' }),
    )
    expect(lastFrame()).toContain('输入消息...')
  })

  it('显示 ❯ 提示符', () => {
    const { lastFrame } = render(React.createElement(InputRender, { text: 'x', caret: 0 }))
    expect(lastFrame()).toContain('❯')
  })

  it('有文本显示完整内容', () => {
    const { lastFrame } = render(React.createElement(InputRender, { text: 'hello', caret: 2 }))
    expect(lastFrame()).toContain('hello')
  })

  it('中文文本完整显示', () => {
    const { lastFrame } = render(
      React.createElement(InputRender, { text: '你好世界', caret: 2 }),
    )
    expect(lastFrame()).toContain('你好世界')
  })

  it('caret 在末尾（反色空格占位）', () => {
    const { lastFrame } = render(React.createElement(InputRender, { text: 'abc', caret: 3 }))
    // 完整文本显示，caret 在末尾（视觉反色空格）
    expect(lastFrame()).toContain('abc')
  })

  it('无 placeholder 空文本不崩', () => {
    const { lastFrame } = render(React.createElement(InputRender, { text: '', caret: 0 }))
    expect(lastFrame()).toBeDefined()
  })

  it('emoji 不拆字素', () => {
    const { lastFrame } = render(
      React.createElement(InputRender, { text: 'a😀b', caret: 2 }),
    )
    expect(lastFrame()).toContain('😀')
  })
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('粘贴行尾归一（xterm.js 系终端粘贴把换行转裸 \\r）', () => {
  it('裸 \\r 粘贴 → 归一为 \\n（渲染层不再被终端当回到行首覆盖）', async () => {
    const onInput = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput }))
    await flush()
    stdin.write('甲行\r乙行\r丙行')
    await flush()
    expect(onInput).toHaveBeenCalledWith({ text: '甲行\n乙行\n丙行', caret: 8 })
    // 输入文本不含裸 \r（真终端下 \r 输出=回到行首逐段覆盖，视觉只剩最后一行）
    const text = (onInput.mock.calls[0]?.[0] as { text: string }).text
    expect(text).not.toContain('\r')
  })

  it('\\r\\n 粘贴同样归一为 \\n', async () => {
    const onInput = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput }))
    await flush()
    stdin.write('第一行\r\n第二行')
    await flush()
    expect(onInput).toHaveBeenCalledWith({ text: '第一行\n第二行', caret: 7 })
  })

  it('普通输入不受影响', async () => {
    const onInput = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput }))
    await flush()
    stdin.write('hello')
    await flush()
    expect(onInput).toHaveBeenCalledWith({ text: 'hello', caret: 5 })
  })
})
