import { describe, it, expect } from 'vitest'
import { foldStreamText, STREAM_MAX_LINES } from '../../src/tui/stream.js'

describe('foldStreamText', () => {
  it('短文本不折叠', () => {
    const r = foldStreamText('a\nb\nc')
    expect(r.folded).toBe(0)
    expect(r.lines).toEqual(['a', 'b', 'c'])
    expect(r.total).toBe(3)
  })

  it('单行不折叠', () => {
    const r = foldStreamText('only one line')
    expect(r.folded).toBe(0)
    expect(r.lines).toEqual(['only one line'])
    expect(r.total).toBe(1)
  })

  it('空文本：split 产生 1 个空串', () => {
    const r = foldStreamText('')
    expect(r.folded).toBe(0)
    expect(r.lines).toEqual([''])
    expect(r.total).toBe(1)
  })

  it(`恰好 ${STREAM_MAX_LINES} 行不折叠`, () => {
    const r = foldStreamText('1\n2\n3')
    expect(r.folded).toBe(0)
    expect(r.total).toBe(STREAM_MAX_LINES)
  })

  it(`超过 ${STREAM_MAX_LINES} 行：折叠头部，显示尾部 ${STREAM_MAX_LINES} 行`, () => {
    const r = foldStreamText('1\n2\n3\n4\n5\n6\n7\n8')
    expect(r.folded).toBe(5)
    expect(r.lines).toEqual(['6', '7', '8'])
    expect(r.total).toBe(8)
  })

  it('只超 1 行', () => {
    const r = foldStreamText('1\n2\n3\n4')
    expect(r.folded).toBe(1)
    expect(r.lines).toEqual(['2', '3', '4'])
  })

  it('自定义 maxLines', () => {
    const r = foldStreamText('a\nb\nc\nd', 2)
    expect(r.folded).toBe(2)
    expect(r.lines).toEqual(['c', 'd'])
  })

  it('maxLines=1 只显示末行', () => {
    const r = foldStreamText('a\nb\nc', 1)
    expect(r.folded).toBe(2)
    expect(r.lines).toEqual(['c'])
  })
})
