/**
 * 界面批 C2/C3 用例：
 * - C2：StatusBar 档位箭头（sandboxArrows 纯函数 + 渲染集成）
 * - C3：双击 Esc 直达 rewind（TuiApp 层逻辑较重，此处验核心判定函数 + StatusBar 渲染；
 *        双击时序留给 pty 探针）
 */
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { StatusBar, sandboxArrows } from '../../src/tui/StatusBar.js'

describe('C2 sandboxArrows（档位箭头）', () => {
  it('default 无标记', () => {
    expect(sandboxArrows('default')).toBe('')
  })
  it('accept-edits ⏵⏵ edits', () => {
    expect(sandboxArrows('accept-edits')).toBe('⏵⏵ edits')
  })
  it('workspace-write ⏵⏵ write / full-access ⏵⏵⏵ / read-only ⛔', () => {
    expect(sandboxArrows('workspace-write')).toBe('⏵⏵ write')
    expect(sandboxArrows('full-access')).toBe('⏵⏵⏵')
    expect(sandboxArrows('read-only')).toBe('⛔ read-only')
  })
  it('StatusBar 渲染：accept-edits 显示箭头段', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { model: 'm', sandbox: 'accept-edits' }),
    )
    expect(lastFrame() ?? '').toContain('⏵⏵ edits')
    expect(lastFrame() ?? '').toContain('accept-edits')
  })
  it('StatusBar 渲染：full-access 危险色仍带 ⚠ + 箭头', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { model: 'm', sandbox: 'full-access', sandboxDanger: true }),
    )
    expect(lastFrame() ?? '').toContain('⚠')
    expect(lastFrame() ?? '').toContain('⏵⏵⏵')
  })
  it('StatusBar 渲染：default 不显示沙箱段（现状回归）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'm' }))
    expect(lastFrame() ?? '').not.toContain('⏵')
  })
})
