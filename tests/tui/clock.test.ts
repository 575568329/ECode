import { describe, it, expect, beforeEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { useClock, __resetClockForTest } from '../../src/tui/clock.js'

beforeEach(() => {
  __resetClockForTest()
})

describe('useClock', () => {
  it('渲染返回 frame 数字（初始 0）', () => {
    const C = () => {
      const f = useClock()
      return React.createElement(Text, null, `frame=${f}`)
    }
    const { lastFrame } = render(React.createElement(C))
    expect(lastFrame()).toContain('frame=0')
  })

  it('不崩溃（hook 正常挂载/卸载）', () => {
    const C = () => {
      useClock()
      return React.createElement(Text, null, 'ok')
    }
    const { lastFrame, unmount } = render(React.createElement(C))
    expect(lastFrame()).toContain('ok')
    expect(() => unmount()).not.toThrow()
  })
})
