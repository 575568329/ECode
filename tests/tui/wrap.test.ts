import { describe, it, expect } from 'vitest'
import stringWidth from 'string-width'
import { parseAnsi } from '../../src/tui/ansi.js'
import { smartWrapAnsi } from '../../src/tui/wrap.js'

/** 每行显示宽度都不超 width（宽字符切不动的不可避免溢出除外） */
const allLinesFit = (out: string, width: number): boolean =>
  out.split('\n').every((l) => stringWidth(l) <= width)

describe('smartWrapAnsi 智能折行', () => {
  it('短文本不折行，原样返回', () => {
    expect(smartWrapAnsi('hello 世界', 40)).toBe('hello 世界')
  })

  it('长 URL 在语义边界断开（每段可辨认）', () => {
    const out = smartWrapAnsi('GET api/presBasic/getRppQuestion?taskId=', 20)
    // 词头接行 + 边界切片：GET api/presBasic/ | getRppQuestion? | taskId=
    expect(out.split('\n')).toEqual(['GET api/presBasic/', 'getRppQuestion?', 'taskId='])
    expect(allLinesFit(out, 20)).toBe(true)
  })

  it('整词放得下一行就保持完整（不因当前行放不下而拆词）', () => {
    const out = smartWrapAnsi('abcdefghij xyz', 10)
    // 'xyz' 整词独占新行，而不是切成 'xy' 接在第一行
    expect(out.split('\n')).toEqual(['abcdefghij', 'xyz'])
  })

  it('中文长句在字符间断开', () => {
    const out = smartWrapAnsi('这是一段没有空格的中文长句', 10)
    expect(out.split('\n')).toEqual(['这是一段没', '有空格的中', '文长句'])
    expect(allLinesFit(out, 10)).toBe(true)
  })

  it('无断点的长游程按显示宽度硬切', () => {
    const out = smartWrapAnsi('a1b2c3d4e5f6g7h8i9j0', 6)
    expect(out.split('\n')).toEqual(['a1b2c3', 'd4e5f6', 'g7h8i9', 'j0'])
  })

  it('行宽上限恒成立（混合内容）', () => {
    const out = smartWrapAnsi(
      '参考 https://example.com/a/b/c?x=1&y=2 与 /usr/local/bin/node 详见文档说明，这是一段混合内容',
      16,
    )
    expect(allLinesFit(out, 16)).toBe(true)
    // 内容无丢失：剥 ANSI 拼回含全部原文（空白归一）
    const joined = parseAnsi(out)
      .map((s) => s.text)
      .join('')
      .replace(/\n/g, '')
    expect(joined).toContain('https://example.com/')
    expect(joined).toContain('/usr/local/bin/')
  })

  it('ANSI 样式跨折行保留（每行重新套 SGR，parseAnsi 无损回读）', () => {
    const colored = '\u001b[36m' + 'ab/cd/ef/gh/ij/kl/mn/op/qr/st/uv' + '\u001b[39m'
    const out = smartWrapAnsi(colored, 10)
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(allLinesFit(out, 10)).toBe(true)
    for (const line of lines) {
      const spans = parseAnsi(line)
      for (const span of spans) {
        if (span.text.trim() !== '') expect(span.color).toBe('cyan')
      }
    }
  })

  it('空白归一：连续空白/换行折叠为单空格', () => {
    expect(smartWrapAnsi('a   b\n\nc', 40)).toBe('a b c')
  })

  it('空串与越界宽度防御', () => {
    expect(smartWrapAnsi('', 20)).toBe('')
    expect(smartWrapAnsi('abc', 0)).toBe('abc')
  })
})
