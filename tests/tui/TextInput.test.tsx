import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { InputRender, TextInput, foldInputView } from '../../src/tui/TextInput.js'

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

describe('输入大段粘贴折叠（>5 行替代显示，提交不受影响）', () => {
  it('≤5 行不折叠照常显示', () => {
    const text = ['一', '二', '三', '四', '五'].join('\n')
    const { lastFrame } = render(React.createElement(InputRender, { text, caret: 0 }))
    const f = lastFrame() ?? ''
    for (const w of ['一', '二', '三', '四', '五']) expect(f).toContain(w)
    expect(f).not.toContain('已折叠')
  })

  it('8 行 caret 在末尾 → 头 5 行 + 折叠指示 + caret 行', () => {
    const lines = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']
    const text = lines.join('\n')
    const caret = text.length
    const { lastFrame } = render(React.createElement(InputRender, { text, caret }))
    const f = lastFrame() ?? ''
    expect(f).toContain('已折叠 2 行（共 8 行）')
    for (const w of ['L1', 'L2', 'L3', 'L4', 'L5', 'L8']) expect(f).toContain(w)
    expect(f).not.toContain('L6')
    expect(f).not.toContain('L7')
  })

  it('caret 在中部折叠区 → 头窗 + 上下双指示 + caret 行可见', () => {
    const lines = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']
    const text = lines.join('\n')
    const caret = text.indexOf('H8') // 第 8 行（0-based 7）
    const { lastFrame } = render(React.createElement(InputRender, { text, caret }))
    const f = lastFrame() ?? ''
    expect(f).toContain('H1')
    expect(f).toContain('H8') // caret 行亮出
    expect(f).not.toContain('H6')
    expect(f.split('已折叠').length - 1).toBe(2) // 上下两条指示
  })

  it('caret 移到头部区域 → 可见窗随 caret 移动', () => {
    const lines = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']
    const text = lines.join('\n')
    const caret = 3 // H1 换行后 = 第 2 行行首（H2）
    const { lastFrame } = render(React.createElement(InputRender, { text, caret }))
    const f = lastFrame() ?? ''
    expect(f).toContain('H1')
    expect(f).toContain('H2')
    expect(f).toContain('H5')
    expect(f).not.toContain('H6') // 下方折叠
    expect(f).toContain('已折叠 5 行')
  })

  it('foldInputView：caret 落在换行边界 → 归下一行行首', () => {
    const view = foldInputView('ab\ncd', 3) // 'ab'+'\n'(2)+1 → cd 行首
    expect(view.caretRow).toBe(1)
    expect(view.caretCol).toBe(0)
  })
})

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

describe('手动换行三键位（legacy 终端 Shift+Enter 与 Enter 同字节不可区分）', () => {
  it('Ctrl+J（裸 \n）→ 插入换行不提交', async () => {
    const onInput = vi.fn()
    const onSubmit = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: '第一行', caret: 3, onInput, onSubmit }))
    await flush()
    stdin.write('\n')
    await flush()
    expect(onInput).toHaveBeenCalledWith({ text: '第一行\n', caret: 4 })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Alt+Enter（ESC \r → meta+return）→ 插入换行不提交', async () => {
    const onInput = vi.fn()
    const onSubmit = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: 'a', caret: 1, onInput, onSubmit }))
    await flush()
    stdin.write('\x1b\r')
    await flush()
    expect(onInput).toHaveBeenCalledWith({ text: 'a\n', caret: 2 })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('kitty 协议 Shift+Enter（CSI u 13;2）→ 插入换行不提交', async () => {
    const onInput = vi.fn()
    const onSubmit = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: 'a', caret: 1, onInput, onSubmit }))
    await flush()
    stdin.write('\x1b[13;2u')
    await flush()
    expect(onInput).toHaveBeenCalledWith({ text: 'a\n', caret: 2 })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('普通 Enter 仍提交（不换行）', async () => {
    const onInput = vi.fn()
    const onSubmit = vi.fn()
    const { stdin } = render(React.createElement(TextInput, { value: 'hi', caret: 2, onInput, onSubmit }))
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSubmit).toHaveBeenCalledWith('hi')
    expect(onInput).not.toHaveBeenCalled()
  })
})

describe('foldInputView 物理行感知（M14-V2）', () => {
  it('超长单行 wrap 计入折叠窗（头窗 5 物理行 + 尾部折叠指示）', () => {
    const text = 'y'.repeat(100) // 40 列宽下 3 物理行 × 3 逻辑行
    const three = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)].join('\n')
    const r1 = foldInputView(three, three.length, 5, 40)
    expect(r1.totalPhysical).toBe(9) // 每逻辑行 ceil(100/40)=3
    // caret 在末尾（折叠区）：头窗 5 + 上折叠指示 3 + caret 物理行（'c' 第 3 段）
    expect(r1.rows).toHaveLength(7)
    expect(r1.rows[5]).toMatchObject({ kind: 'folded', count: 3 })
    expect(r1.rows[6]?.text).toBe('c'.repeat(20))
    expect(r1.rows[0]?.text).toBe('a'.repeat(40))
  })

  it('caret 在折叠区：caret 物理行亮出 + 上下折叠指示', () => {
    const lines = ['short', ...Array.from({ length: 10 }, (_, i) => `L${i}${'z'.repeat(100)}`)]
    const text = lines.join('\n')
    const caret = text.length // 末尾
    const r = foldInputView(text, caret, 5, 40)
    // caret 在最后一物理行（全局 30/共 31）：头窗 5 + 上指示 25 + caret 行（末行无下指示）
    expect(r.rows).toHaveLength(7)
    expect(r.rows[5]).toMatchObject({ kind: 'folded', count: 25 })
    expect(r.rows[6]?.kind).toBe('text') // caret 行=L9 逻辑行的第 3 物理段（'L9' 前缀在折叠区）
    expect(r.rows[6]?.text).toMatch(/^z+$/)
  })

  it('caret 物理列按字素索引（审阅 P1-9：与 CaretText/splitAtCaret 口径统一——原显示列口径行中位置错位）', () => {
    const text = '中中中中中'
    // width 8：物理行 [中中中中, 中]；caret=4=第 4 字后→首物理行末（字素 4，与下行首同点——
    // 行末归上一行，与 caretLineCol 边界语义一致）；caret=5=第 5 字后→第二行末（字素 1）
    expect(foldInputView(text, 4, 5, 8)).toMatchObject({ caretRow: 0, caretCol: 4 })
    expect(foldInputView(text, 5, 5, 8)).toMatchObject({ caretRow: 1, caretCol: 1 })
  })

  it('无 width 保持逻辑行旧行为', () => {
    const text = Array.from({ length: 8 }, (_, i) => `L${i}`).join('\n')
    const r = foldInputView(text, text.length, 5)
    expect(r.totalPhysical).toBe(8)
    expect(r.rows[0]?.text).toBe('L0')
    expect(r.rows.some((row) => row.kind === 'folded')).toBe(true)
  })
})
