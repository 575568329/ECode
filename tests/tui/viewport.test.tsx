import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { useViewport } from '../../src/tui/viewport.js'

afterEach(() => cleanup())

function ViewportConsumer({ label }: { label: string }): React.ReactElement {
  const { rows, columns } = useViewport()
  return <Text>{`${label}:${rows}x${columns}`}</Text>
}

describe('F-40 共享 resize 监听（MaxListenersExceededWarning 根治）', () => {
  it('N 个 useViewport 组件只挂 1 个底层 resize 监听（不随组件数增长）', () => {
    // 40 个消费组件（> Node 默认 MaxListeners 10——若仍每组件一挂必爆警告）
    const tree = Array.from({ length: 40 }, (_, i) =>
      React.createElement(ViewportConsumer, { key: i, label: `v${i}` }),
    )
    const { lastFrame, stdout } = render(React.createElement(React.Fragment, null, ...tree))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('v0:')
    expect(frame).toContain('v39:') // 全部正常取到视口
    // 底层监听数：ink 主实例 1 个（interactive resize）+ 本模块共享 1 个 = 2；
    // 若回退为每组件一挂，此处为 41+（MaxListeners 警告即 dogfood 所见）
    const count = typeof (stdout as { listenerCount?: (e: string) => number }).listenerCount === 'function'
      ? (stdout as { listenerCount: (e: string) => number }).listenerCount('resize')
      : -1
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(2)
  })

  it('卸载后退订集合（无累积）', () => {
    const { unmount } = render(React.createElement(ViewportConsumer, { label: 'x' }))
    unmount()
    const { stdout } = render(React.createElement(ViewportConsumer, { label: 'y' }))
    const count = typeof (stdout as { listenerCount?: (e: string) => number }).listenerCount === 'function'
      ? (stdout as { listenerCount: (e: string) => number }).listenerCount('resize')
      : -1
    expect(count).toBeLessThanOrEqual(2)
  })
})
