import { describe, it, expect } from 'vitest'
import {
  createCursor,
  insert,
  backspace,
  deleteRight,
  moveLeft,
  moveRight,
  moveHome,
  moveEnd,
  splitAtCaret,
  graphemes,
  countGraphemes,
  type CursorState,
} from '../../src/tui/cursor.js'

describe('graphemes / countGraphemes', () => {
  it('英文按字符切分', () => {
    expect(graphemes('abc')).toEqual(['a', 'b', 'c'])
    expect(countGraphemes('abc')).toBe(3)
  })

  it('中文每字 1 字素', () => {
    expect(graphemes('你好')).toEqual(['你', '好'])
    expect(countGraphemes('你好')).toBe(2)
  })

  it('emoji ZWJ 组合是 1 字素（👨‍👩‍👧）', () => {
    expect(countGraphemes('👨‍👩‍👧')).toBe(1)
  })

  it('国旗是 1 字素', () => {
    expect(countGraphemes('🇨🇳')).toBe(1)
  })

  it('中英混合', () => {
    expect(graphemes('a你b')).toEqual(['a', '你', 'b'])
  })
})

describe('createCursor', () => {
  it('空文本 caret=0', () => {
    expect(createCursor('')).toEqual({ text: '', caret: 0 })
  })

  it('caret 默认在末尾', () => {
    expect(createCursor('abc')).toEqual({ text: 'abc', caret: 3 })
  })

  it('中文末尾（字素数）', () => {
    expect(createCursor('你好')).toEqual({ text: '你好', caret: 2 })
  })
})

describe('insert', () => {
  it('在中间插入', () => {
    const c = insert({ text: 'ac', caret: 1 }, 'b')
    expect(c).toEqual({ text: 'abc', caret: 2 })
  })

  it('在开头插入', () => {
    const c = insert({ text: 'bc', caret: 0 }, 'a')
    expect(c).toEqual({ text: 'abc', caret: 1 })
  })

  it('在末尾插入', () => {
    const c = insert({ text: 'ab', caret: 2 }, 'c')
    expect(c).toEqual({ text: 'abc', caret: 3 })
  })

  it('插入中文（字素级）', () => {
    const c = insert({ text: '你好', caret: 1 }, '世')
    expect(c).toEqual({ text: '你世好', caret: 2 })
  })

  it('插入多字素串', () => {
    const c = insert({ text: 'ad', caret: 1 }, 'bc')
    expect(c).toEqual({ text: 'abcd', caret: 3 })
  })

  it('插入空串不变', () => {
    const c = insert({ text: 'abc', caret: 1 }, '')
    expect(c).toEqual({ text: 'abc', caret: 1 })
  })
})

describe('backspace', () => {
  it('删前一个字素', () => {
    const c = backspace({ text: 'abc', caret: 2 })
    expect(c).toEqual({ text: 'ac', caret: 1 })
  })

  it('删中文（字素级）', () => {
    const c = backspace({ text: '你好', caret: 1 })
    expect(c).toEqual({ text: '好', caret: 0 })
  })

  it('caret=0 不变', () => {
    const c = backspace({ text: 'abc', caret: 0 })
    expect(c).toEqual({ text: 'abc', caret: 0 })
  })

  it('删 emoji 整个字素', () => {
    const c = backspace({ text: 'a😀b', caret: 2 })
    expect(c).toEqual({ text: 'ab', caret: 1 })
  })
})

describe('deleteRight', () => {
  it('删 caret 处字素', () => {
    const c = deleteRight({ text: 'abc', caret: 1 })
    expect(c).toEqual({ text: 'ac', caret: 1 })
  })

  it('caret 在末尾不变', () => {
    const c = deleteRight({ text: 'ab', caret: 2 })
    expect(c).toEqual({ text: 'ab', caret: 2 })
  })
})

describe('move', () => {
  const c: CursorState = { text: 'abc', caret: 1 }

  it('moveLeft', () => {
    expect(moveLeft(c).caret).toBe(0)
  })

  it('moveLeft at 0 不变', () => {
    expect(moveLeft({ text: 'ab', caret: 0 }).caret).toBe(0)
  })

  it('moveRight', () => {
    expect(moveRight(c).caret).toBe(2)
  })

  it('moveRight at end 不变', () => {
    expect(moveRight({ text: 'ab', caret: 2 }).caret).toBe(2)
  })

  it('moveHome', () => {
    expect(moveHome(c).caret).toBe(0)
  })

  it('moveEnd', () => {
    expect(moveEnd(c).caret).toBe(3)
  })

  it('move 保持 text 不变', () => {
    expect(moveLeft(c).text).toBe('abc')
    expect(moveHome(c).text).toBe('abc')
  })
})

describe('不可变性', () => {
  it('操作不修改原状态', () => {
    const original: CursorState = { text: 'abc', caret: 1 }
    insert(original, 'X')
    backspace(original)
    moveLeft(original)
    expect(original).toEqual({ text: 'abc', caret: 1 })
  })
})

describe('splitAtCaret', () => {
  it('caret 在中间', () => {
    expect(splitAtCaret('abc', 1)).toEqual({ before: 'a', at: 'b', after: 'c' })
  })

  it('caret 在开头', () => {
    expect(splitAtCaret('abc', 0)).toEqual({ before: '', at: 'a', after: 'bc' })
  })

  it('caret 在末尾 → at 为空格占位', () => {
    expect(splitAtCaret('abc', 3)).toEqual({ before: 'abc', at: ' ', after: '' })
  })

  it('空文本 caret=0 → at 空格', () => {
    expect(splitAtCaret('', 0)).toEqual({ before: '', at: ' ', after: '' })
  })

  it('中文（字素级切分）', () => {
    expect(splitAtCaret('你好', 1)).toEqual({ before: '你', at: '好', after: '' })
  })
})
