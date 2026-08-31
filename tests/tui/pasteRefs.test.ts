/**
 * 粘贴 token 纯函数测试（输入体验批二期，学 CC [Pasted text #N] 设计理念）。
 */
import { describe, it, expect } from 'vitest'
import { formatPasteRef, shouldTokenize, parsePasteRefs, expandPasteRefs, prunePasteRefs, PASTE_THRESHOLD } from '../../src/tui/pasteRefs.js'

describe('formatPasteRef', () => {
  it('有换行 → +N 行后缀（N=换行符数，CC 同口径）', () => {
    expect(formatPasteRef(1, 'a\nb\nc')).toBe('[粘贴#1 +2 行]')
    expect(formatPasteRef(2, 'a\r\nb')).toBe('[粘贴#2 +1 行]')
  })
  it('无换行 → 短形态', () => {
    expect(formatPasteRef(3, 'x'.repeat(900))).toBe('[粘贴#3]')
  })
})

describe('shouldTokenize（CC 条件：>800 字符或 >2 行）', () => {
  it('短单行不 token 化', () => {
    expect(shouldTokenize('hello world')).toBe(false)
  })
  it('超 800 字符单行 token 化', () => {
    expect(shouldTokenize('x'.repeat(PASTE_THRESHOLD + 1))).toBe(true)
    expect(shouldTokenize('x'.repeat(PASTE_THRESHOLD))).toBe(false)
  })
  it('超 2 行 token 化（不足 800 字符也化）', () => {
    expect(shouldTokenize('a\nb\nc\nd')).toBe(true)
    expect(shouldTokenize('a\nb\nc')).toBe(false)
  })
})

describe('parsePasteRefs / expandPasteRefs', () => {
  it('解析带与不带行数后缀两种形态', () => {
    const refs = parsePasteRefs('前[粘贴#1 +11 行]中[粘贴#2]后')
    expect(refs.map((r) => r.id)).toEqual([1, 2])
    expect(refs[0]?.match).toBe('[粘贴#1 +11 行]')
    expect(refs[1]?.match).toBe('[粘贴#2]')
  })

  it('展开为存储全文；无条目的 token 保持原样', () => {
    const store = new Map([[1, 'L1\nL2\nL3']])
    expect(expandPasteRefs('看这个[粘贴#1 +2 行]谢谢', store)).toBe('看这个L1\nL2\nL3谢谢')
    expect(expandPasteRefs('孤儿[粘贴#9]', store)).toBe('孤儿[粘贴#9]')
  })

  it('倒序 splice：粘贴内容里的伪 token 不被二次展开', () => {
    const store = new Map([
      [1, '内容含伪标记 [粘贴#2] 与 [粘贴#3 +1 行]'],
      [2, '真内容'],
    ])
    const draft = 'A[粘贴#1 +2 行]B[粘贴#2]'
    const expanded = expandPasteRefs(draft, store)
    // #1 展开后内部的 [粘贴#2] 字样必须保持原样（不被 #2 的内容覆盖）
    expect(expanded).toBe('A内容含伪标记 [粘贴#2] 与 [粘贴#3 +1 行]B真内容')
  })

  it('多处引用同一 id 各自展开', () => {
    const store = new Map([[5, 'XX']])
    expect(expandPasteRefs('[粘贴#5]--[粘贴#5 +0 行]'.replace(' +0 行', ''), store)).toBe('XX--XX')
  })
})

describe('prunePasteRefs（删标签=删内容）', () => {
  it('无 token 引用的 id 进剪枝清单', () => {
    const store = new Map([
      [1, 'a'],
      [2, 'b'],
    ])
    expect(prunePasteRefs(store, '草稿还有[粘贴#1]')).toEqual([2])
  })
})
