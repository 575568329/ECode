import {describe, it, expect, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { InputRender, TextInput, foldInputView } from '../../src/tui/TextInput.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

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

describe('输入框不折叠（输入体验批二期：大粘贴走 token 化，渲染恒全量）', () => {
  it('≤5 行不折叠照常显示', () => {
    const text = ['一', '二', '三', '四', '五'].join('\n')
    const { lastFrame } = render(React.createElement(InputRender, { text, caret: 0 }))
    const f = lastFrame() ?? ''
    for (const w of ['一', '二', '三', '四', '五']) expect(f).toContain(w)
    expect(f).not.toContain('已折叠')
  })

  it('8 行超旧折叠阈值 → 全量渲染（无折叠指示）', () => {
    const lines = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']
    const text = lines.join('\n')
    const { lastFrame } = render(React.createElement(InputRender, { text, caret: text.length }))
    const f = lastFrame() ?? ''
    for (const w of lines) expect(f).toContain(w)
    expect(f).not.toContain('已折叠')
  })

  it('foldInputView：caret 落在换行边界 → 归下一行行首（退役纯函数仍保正确）', () => {
    const view = foldInputView('ab\ncd', 3)
    expect(view.caretRow).toBe(1)
    expect(view.caretCol).toBe(0)
  })
})

describe('查看窗（输入体验批：foldInputView anchor 偏置——PgUp/PgDn 滚看全文）', () => {
  const text10 = Array.from({ length: 10 }, (_, i) => `V${i + 1}`).join('\n')

  it('anchor=0 等价默认头窗', () => {
    const a = foldInputView(text10, 0, 5, undefined, 0)
    const d = foldInputView(text10, 0, 5)
    expect(a.rows.map((r) => r.text)).toEqual(d.rows.map((r) => r.text))
  })

  it('anchor=3 → 窗口平移到物理行 3-7，上下指示 3/2', () => {
    const v = foldInputView(text10, 0, 5, undefined, 3)
    const texts = v.rows.filter((r) => r.kind === 'text').map((r) => r.text)
    expect(texts).toEqual(['V4', 'V5', 'V6', 'V7', 'V8'])
    const folded = v.rows.filter((r) => r.kind === 'folded')
    expect(folded.map((r) => r.count)).toEqual([3, 2])
    expect(v.caretRow).toBe(-1) // caret 不在窗内（caret=0 在 V1）
  })

  it('caret 在窗内 → caretRow 为窗内相对行且反色定位正确', () => {
    const caret = text10.indexOf('V6')
    const v = foldInputView(text10, caret, 5, undefined, 3)
    expect(v.caretRow).toBe(3) // 窗口渲染行序：上指示(0) + V4(1) V5(2) V6(3)——caret 在 V6
    expect(v.caretCol).toBe(0)
  })

  it('anchor 超界 clamp 到 total-maxLines', () => {
    const v = foldInputView(text10, 0, 5, undefined, 99)
    const texts = v.rows.filter((r) => r.kind === 'text').map((r) => r.text)
    expect(texts).toEqual(['V6', 'V7', 'V8', 'V9', 'V10'])
    expect(v.rows[0].kind).toBe('folded')
  })

  it('物理行路径（width）同样支持 anchor（超长单行 wrap 场景）', () => {
    // 单逻辑行 wrap 成 7 物理行（每行 2 列宽），anchor=2 → 窗口看物理行 2-6
    const long = 'abcdefghijklmn'
    const v = foldInputView(long, 0, 5, 2, 2)
    const texts = v.rows.filter((r) => r.kind === 'text').map((r) => r.text)
    expect(texts).toEqual(['ef', 'gh', 'ij', 'kl', 'mn'])
    expect(v.rows[0].kind).toBe('folded')
    expect(v.rows[0].count).toBe(2)
    expect(v.totalPhysical).toBe(7)
  })
})

describe('粘贴 token 化（输入体验批二期：大块插入交 onPasteText 判定）', () => {
  it('多行 chunk（>2 行换行阈值）→ onPasteText 收归一全文，token 插入草稿', async () => {
    const onInput = vi.fn()
    const onPasteText = vi.fn(() => '[粘贴#1 +4 行]')
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput, onPasteText }))
    await flush()
    stdin.write('甲\r乙\r丙\r丁\r戊')
    await flush()
    expect(onPasteText).toHaveBeenCalledWith('甲\n乙\n丙\n丁\n戊')
    expect(onInput).toHaveBeenCalledWith({ text: '[粘贴#1 +4 行]', caret: expect.any(Number) })
  })

  it('短 chunk（2 字符）不触发 token 判定（未达阈值原样直插）', async () => {
    const onInput = vi.fn()
    const onPasteText = vi.fn(() => null as string | null)
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput, onPasteText }))
    await flush()
    stdin.write('hi')
    await new Promise((r) => setTimeout(r, 150)) // 越过 60ms 置换窗
    expect(onPasteText).not.toHaveBeenCalled()
    expect(onInput).toHaveBeenCalledWith({ text: 'hi', caret: expect.any(Number) })
  })

  it('onPasteText 返回 null → 归一原文直插（3 行低于阈值同理不判）', async () => {
    const onInput = vi.fn()
    const onPasteText = vi.fn(() => null)
    const { stdin } = render(React.createElement(TextInput, { value: '', caret: 0, onInput, onPasteText }))
    await flush()
    stdin.write('甲\r乙\r丙\r丁\r戊')
    await flush()
    expect(onPasteText).toHaveBeenCalled()
    expect(onInput).toHaveBeenCalledWith({ text: '甲\n乙\n丙\n丁\n戊', caret: expect.any(Number) })
  })

  it('recent-span 置换：conpty 拆块两拍聚合（首拍未达阈值入 span，次拍续接）→ 60ms 后 onPasteText 以拼接全文调用一次', async () => {
    const onInput = vi.fn()
    const onPasteText = vi.fn((t: string) => '[粘贴#1]')
    function Harness(): React.ReactElement {
      const [cur, setCur] = React.useState({ text: '', caret: 0 })
      return React.createElement(TextInput, {
        value: cur.text, caret: cur.caret, onInput: (n: { text: string; caret: number }) => { onInput(n); setCur(n) }, onPasteText,
      })
    }
    const { stdin } = render(React.createElement(Harness))
    await flush()
    // 模拟 conpty 拆块：首拍 500 字符（未达 800 阈值→进 span 不立即 token 化）
    stdin.write('x'.repeat(500))
    await new Promise((r) => setTimeout(r, 20)) // < 60ms 窗：同 span 续接（value 已回灌，caret 前进）
    stdin.write('x'.repeat(400)) // 拼接后 900 ≥ 800
    await new Promise((r) => setTimeout(r, 200)) // 越过 60ms 置换窗
    expect(onPasteText).toHaveBeenCalledTimes(1)
    expect(onPasteText).toHaveBeenCalledWith('x'.repeat(900))
    const applied = onInput.mock.calls.map((c) => c[0] as { text: string })
    expect(applied.at(-1)?.text).toBe('[粘贴#1]')
  })

  it('recent-span 放弃：置换前草稿被编辑（父级覆写）→ slice 失配不置换', async () => {
    const onInput = vi.fn()
    const onPasteText = vi.fn(() => '[粘贴#1]')
    const { stdin, rerender } = render(React.createElement(TextInput, { value: '', caret: 0, onInput, onPasteText }))
    await flush()
    stdin.write('x'.repeat(500))
    await new Promise((r) => setTimeout(r, 20))
    // 置换窗内父级覆写草稿（如 insert 通道/清空）
    rerender(React.createElement(TextInput, { value: '被覆写', caret: 3, onInput, onPasteText }))
    await new Promise((r) => setTimeout(r, 200))
    expect(onPasteText).not.toHaveBeenCalled()
    expect(onInput.mock.calls.every((c) => (c[0] as { text: string }).text !== '[粘贴#1]')).toBe(true)
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
