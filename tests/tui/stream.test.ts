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

describe('foldStreamText 物理行化（M14-V2）', () => {
  it('width 提供时超长单行按物理行折叠', () => {
    const r = foldStreamText('x'.repeat(100), 3, 30)
    expect(r.total).toBe(4) // ceil(100/30)
    expect(r.lines).toEqual(['x'.repeat(30), 'x'.repeat(30), 'x'.repeat(10)]) // 尾 3 物理行
    expect(r.folded).toBe(1)
  })

  it('CJK 宽度感知（中 = 2 列）', () => {
    const r = foldStreamText('中'.repeat(20), 2, 10)
    expect(r.total).toBe(4) // 每行 5 字
    expect(r.folded).toBe(2)
  })

  it('无 width 保持逻辑行旧行为', () => {
    const r = foldStreamText('1\n2\n3\n4\n5', 3)
    expect(r.lines).toEqual(['3', '4', '5'])
    expect(r.folded).toBe(2)
    expect(r.total).toBe(5)
  })

  it('宽度非法（0）回退逻辑行', () => {
    const r = foldStreamText('1\n2\n3\n4\n5', 3, 0)
    expect(r.total).toBe(5)
  })
})

// —— 批2a（P1-A）增量折叠：等价性 / 前缀稳定性钉子 / 尾行超宽有界 ——
import wrapAnsi from 'wrap-ansi'
import type { StreamFoldCacheBox } from '../../src/tui/stream.js'

describe('wrap-ansi 前缀稳定性钉子（批2a 增量化的地基——版本升级漂移即红）', () => {
  const samples = [
    'aaa bbb ccc ddd',
    '中文中文中文中英文mix中1234567890',
    '{"json":"minified","long":[1,2,3,4,5,6,7,8,9,10]}',
    '   缩进行 with spaces   and tabs\tafter',
    'no-space-at-all-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]
  it('贪心断行下已产出物理行不受 append 影响（多宽度多样本）', () => {
    for (const width of [10, 20, 40]) {
      for (const s of samples) {
        for (const suffix of ['x', '中', ' word', '\n新行', 'yyyyyyyyyyyyyyyyyyyyyyyy']) {
          const w1 = wrapAnsi(s, width, { hard: true, trim: false }).split('\n')
          const w2 = wrapAnsi(s + suffix, width, { hard: true, trim: false }).split('\n')
          const stable = w1.slice(0, -1)
          expect(w2.slice(0, stable.length)).toEqual(stable)
        }
      }
    }
  })
})

describe('foldStreamText 增量路径（cache）', () => {
  it('逐步 append 与全量折叠逐行等价（含 CJK/超宽单行/空行/换行新增）', () => {
    const box: StreamFoldCacheBox = { current: null }
    // 混合形态流：短行/空行/超宽单行（持续 append 不换行）/再换行
    let text = ''
    const pieces = ['第一段短文\n\n', 'x'.repeat(300), '中'.repeat(120), '\n尾段', '继续追加的尾巴'.repeat(30), '\n', '新逻辑行']
    for (const p of pieces) {
      // 每片再按 7 字符细粒度喂入（模拟 token 级 delta）
      for (let i = 0; i < p.length; i += 7) {
        text += p.slice(i, i + 7)
        const inc = foldStreamText(text, 3, 30, box)
        const full = foldStreamText(text, 3, 30)
        expect(inc).toEqual(full)
      }
    }
  })

  it('增量 wrap 输入有界：文本涨到 25KB，每步 wrap 的输入长度 ≤ 两倍宽度级', () => {
    const box: StreamFoldCacheBox = { current: null }
    let text = ''
    // 直接观察缓存不变量：consumed 单调推进，pending 有界
    for (let i = 0; i < 400; i++) {
      text += '中'.repeat(10) // 无换行持续 append（最坏形态：单逻辑行涨到 4KB）
      foldStreamText(text, 3, 30, box)
      const c = box.current
      expect(c).not.toBeNull()
      if (c === null) throw new Error('unreachable')
      // pending = 未稳定尾段，约一个物理行（宽度 30 → 显示宽 15 中文字）+ 少量余量
      expect(c.pending.length).toBeLessThanOrEqual(40)
      expect(c.consumed + c.pending.length).toBe(text.length)
    }
    // 总行数与全量一致
    expect(foldStreamText(text, 3, 30, box).total).toBe(foldStreamText(text, 3, 30).total)
  })

  it('宽度变化（resize）自动重算，结果与全新缓存一致', () => {
    const box: StreamFoldCacheBox = { current: null }
    foldStreamText('aaaa\nbbbb\ncccc', 3, 30, box)
    const r = foldStreamText('aaaa\nbbbb\ncccc', 3, 10, box)
    expect(r).toEqual(foldStreamText('aaaa\nbbbb\ncccc', 3, 10))
  })

  it('非 append 变更（长度回缩）自动重算不出错', () => {
    const box: StreamFoldCacheBox = { current: null }
    foldStreamText('aaaaaaaaaaaaaaaaaaaa', 3, 30, box)
    const r = foldStreamText('short', 3, 30, box)
    expect(r).toEqual(foldStreamText('short', 3, 30))
  })

  it('空文本口径与全量一致（单空行）', () => {
    const box: StreamFoldCacheBox = { current: null }
    expect(foldStreamText('', 3, 30, box)).toEqual(foldStreamText('', 3, 30))
  })
})
