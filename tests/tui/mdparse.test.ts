import { describe, it, expect } from 'vitest'
import { hasMarkdownSyntax, inlineToAnsi, type InlineTok } from '../../src/tui/mdparse.js'

describe('hasMarkdownSyntax', () => {
  it('纯文本无语法', () => {
    expect(hasMarkdownSyntax('hello world 普通文字')).toBe(false)
  })

  it('空字符串', () => {
    expect(hasMarkdownSyntax('')).toBe(false)
  })

  it('标题 # ', () => {
    expect(hasMarkdownSyntax('# Title')).toBe(true)
  })

  it('粗体 ** **', () => {
    expect(hasMarkdownSyntax('text **bold** text')).toBe(true)
  })

  it('行内代码', () => {
    expect(hasMarkdownSyntax('use `npm` to install')).toBe(true)
  })

  it('列表 - ', () => {
    expect(hasMarkdownSyntax('- item\n- item2')).toBe(true)
  })

  it('有序列表', () => {
    expect(hasMarkdownSyntax('1. first\n2. second')).toBe(true)
  })

  it('代码块 ```', () => {
    expect(hasMarkdownSyntax('```\ncode\n```')).toBe(true)
  })

  it('引用 >', () => {
    expect(hasMarkdownSyntax('> quote')).toBe(true)
  })

  it('表格 |', () => {
    expect(hasMarkdownSyntax('| a | b |\n|---|---|')).toBe(true)
  })

  it('链接 [text](url)', () => {
    expect(hasMarkdownSyntax('see [docs](http://x)')).toBe(true)
  })
})

describe('inlineToAnsi', () => {
  it('纯文本 token', () => {
    expect(inlineToAnsi([{ type: 'text', text: 'hello' }])).toBe('hello')
  })

  it('空数组', () => {
    expect(inlineToAnsi([])).toBe('')
  })

  it('undefined 安全', () => {
    expect(inlineToAnsi(undefined)).toBe('')
  })

  it('strong → 粗体 SGR', () => {
    const tokens: InlineTok[] = [{ type: 'strong', tokens: [{ type: 'text', text: 'bold' }] }]
    expect(inlineToAnsi(tokens)).toBe('\x1b[1mbold\x1b[22m')
  })

  it('em → 斜体 SGR', () => {
    const tokens: InlineTok[] = [{ type: 'em', tokens: [{ type: 'text', text: 'italic' }] }]
    expect(inlineToAnsi(tokens)).toBe('\x1b[3mitalic\x1b[23m')
  })

  it('codespan → cyan SGR', () => {
    expect(inlineToAnsi([{ type: 'codespan', text: 'x' }])).toBe('\x1b[36mx\x1b[39m')
  })

  it('link → text + dim href（M2 纯文本 linkify）', () => {
    const tokens: InlineTok[] = [
      { type: 'link', href: 'http://x', tokens: [{ type: 'text', text: 'go' }] },
    ]
    expect(inlineToAnsi(tokens)).toBe('go\x1b[2m (http://x)\x1b[22m')
  })

  it('br → 换行', () => {
    expect(inlineToAnsi([{ type: 'br' }])).toBe('\n')
  })

  it('image → [图片] 占位', () => {
    expect(inlineToAnsi([{ type: 'image', text: 'logo' }])).toBe('\x1b[2m[图片: logo]\x1b[22m')
  })

  it('混合序列拼接', () => {
    const tokens: InlineTok[] = [
      { type: 'text', text: 'a ' },
      { type: 'strong', tokens: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' c' },
    ]
    expect(inlineToAnsi(tokens)).toBe('a \x1b[1mb\x1b[22m c')
  })

  it('嵌套：strong 内含 em', () => {
    const tokens: InlineTok[] = [
      {
        type: 'strong',
        tokens: [{ type: 'em', tokens: [{ type: 'text', text: 'x' }] }],
      },
    ]
    expect(inlineToAnsi(tokens)).toBe('\x1b[1m\x1b[3mx\x1b[23m\x1b[22m')
  })

  it('未知 type 回退到 text/raw', () => {
    expect(inlineToAnsi([{ type: 'unknown', text: 'fallback' }])).toBe('fallback')
  })
})
