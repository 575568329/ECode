import {describe, expect, it, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import { Folded } from '../../src/tui/Folded.js'
import { foldLines } from '../../src/tui/viewport.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

describe('Folded 折叠展示件', () => {
  it('未折叠时不渲染提示行', () => {
    const fold = foldLines('a\nb', 5, 40)
    const { lastFrame } = render(<Folded fold={fold} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('a')
    expect(frame).not.toContain('已折叠')
  })

  it('tail 折叠：提示行在顶部，带计数与 hint', () => {
    const fold = foldLines('1\n2\n3\n4\n5', 2, 40)
    const { lastFrame } = render(<Folded fold={fold} hint="Ctrl+O 展开" />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('↑ 3 行已折叠（共 5 行） · Ctrl+O 展开')
    expect(frame).toContain('4')
    expect(frame.indexOf('已折叠')).toBeLessThan(frame.lastIndexOf('4'))
  })

  it('head-tail 折叠：头段与尾段都在，提示行在中间', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `L${i}`)
    const fold = foldLines(lines.join('\n'), 4, 40, 'head-tail')
    const { lastFrame } = render(<Folded fold={fold} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('L0')
    expect(frame).toContain('L7')
    expect(frame).toContain('4 行已折叠')
    expect(frame).not.toContain('L3')
  })
})
