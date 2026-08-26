/** hash 路由纯函数——解析/生成往返 + 旧 'new' 占位语义退役（真新建立即转正实 id） */
import { describe, expect, it } from 'vitest'
import { makeHash, parseHash } from '../src/routing'

describe('parseHash', () => {
  it('根路径=未选项目', () => {
    expect(parseHash('#/')).toEqual({ p: null, s: null })
    expect(parseHash('')).toEqual({ p: null, s: null })
  })
  it('项目选中未选会话', () => {
    expect(parseHash('#/p/D%3A%2Fstudy%2FECode')).toEqual({ p: 'D:/study/ECode', s: null })
  })
  it('项目+会话（含特殊字符解码）', () => {
    expect(parseHash('#/p/D%3A%2Ffoo%20bar/s/2026-08-26T10-00-00-000Z-ab12cd34')).toEqual({
      p: 'D:/foo bar',
      s: '2026-08-26T10-00-00-000Z-ab12cd34',
    })
  })
  it("旧 'new' 占位视同未选会话（hero 态输入即开新对话）", () => {
    expect(parseHash('#/p/D%3A%2Fstudy%2FECode/s/new')).toEqual({ p: 'D:/study/ECode', s: null })
  })
})

describe('makeHash', () => {
  it('往返一致（会话 id 不含需转义字符——ISO 时间戳形态）', () => {
    const pos = { p: 'D:/study/ECode', s: '2026-08-26T10-00-00-000Z-ab12cd34' }
    expect(parseHash(makeHash(pos))).toEqual(pos)
  })
  it('未选项目归一根路径', () => {
    expect(makeHash({ p: null, s: null })).toBe('#/')
    expect(makeHash({ p: null, s: 'x' })).toBe('#/')
  })
})
