import { describe, it, expect } from 'vitest'
import { parseAnsi } from '../../src/tui/ansi.js'

describe('parseAnsi', () => {
  it('纯文本返回单 span', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello' }])
  })

  it('空字符串返回空数组', () => {
    expect(parseAnsi('')).toEqual([])
  })

  it('前景色 SGR + reset', () => {
    expect(parseAnsi('\x1b[36mcyan\x1b[0m')).toEqual([{ text: 'cyan', color: 'cyan' }])
  })

  it('reset 后属性清空', () => {
    expect(parseAnsi('\x1b[36mcyan\x1b[0mplain')).toEqual([
      { text: 'cyan', color: 'cyan' },
      { text: 'plain' },
    ])
  })

  it('粗体 + 关闭（22）', () => {
    expect(parseAnsi('\x1b[1mbold\x1b[22m')).toEqual([{ text: 'bold', bold: true }])
  })

  it('颜色与粗体叠加（分序列）', () => {
    expect(parseAnsi('\x1b[36m\x1b[1mcyan bold\x1b[0m')).toEqual([
      { text: 'cyan bold', color: 'cyan', bold: true },
    ])
  })

  it('多参数单序列 1;36', () => {
    expect(parseAnsi('\x1b[1;36mcyan bold\x1b[0m')).toEqual([
      { text: 'cyan bold', color: 'cyan', bold: true },
    ])
  })

  it('亮色 93 → yellowBright', () => {
    expect(parseAnsi('\x1b[93mbright\x1b[0m')).toEqual([{ text: 'bright', color: 'yellowBright' }])
  })

  it('dim → dimColor', () => {
    expect(parseAnsi('\x1b[2mdim\x1b[22m')).toEqual([{ text: 'dim', dimColor: true }])
  })

  it('italic', () => {
    expect(parseAnsi('\x1b[3mitalic\x1b[23m')).toEqual([{ text: 'italic', italic: true }])
  })

  it('underline', () => {
    expect(parseAnsi('\x1b[4munderline\x1b[24m')).toEqual([{ text: 'underline', underline: true }])
  })

  it('忽略非 SGR 的 CSI 序列（清屏 \\x1b[2J）', () => {
    expect(parseAnsi('\x1b[2Jtext')).toEqual([{ text: 'text' }])
  })

  it('多段颜色切换', () => {
    expect(parseAnsi('\x1b[31mred\x1b[32mgreen\x1b[0mend')).toEqual([
      { text: 'red', color: 'red' },
      { text: 'green', color: 'green' },
      { text: 'end' },
    ])
  })

  it('背景色 44 → backgroundColor blue', () => {
    expect(parseAnsi('\x1b[44mbg\x1b[49m')).toEqual([{ text: 'bg', backgroundColor: 'blue' }])
  })

  it('SGR 39 = 重置前景色（cli-highlight 实际用 39 而非 0）', () => {
    expect(parseAnsi('\x1b[34mblue\x1b[39mplain')).toEqual([
      { text: 'blue', color: 'blue' },
      { text: 'plain' },
    ])
  })

  it('cli-highlight 真实输出：const 蓝 + 1 绿（probe 实测）', () => {
    // highlight('const x = 1', {language:'javascript'}) 的真实 ANSI 输出
    const out = '\x1b[34mconst\x1b[39m x = \x1b[32m1\x1b[39m'
    expect(parseAnsi(out)).toEqual([
      { text: 'const', color: 'blue' },
      { text: ' x = ' },
      { text: '1', color: 'green' },
    ])
  })
})
