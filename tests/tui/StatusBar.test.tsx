import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { StatusBar } from '../../src/tui/StatusBar.js'

describe('StatusBar', () => {
  it('显示 model', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'GLM-5.2' }))
    expect(lastFrame()).toContain('GLM-5.2')
  })

  it('含 ECode 前缀', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M' }))
    expect(lastFrame()).toContain('ECode')
  })

  it('显示轮数（含 maxIter）', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { model: 'M', iter: 3, maxIter: 50 }),
    )
    expect(lastFrame()).toContain('轮 3/50')
  })

  it('显示轮数（无 maxIter）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', iter: 7 }))
    expect(lastFrame()).toContain('轮 7')
  })

  it('token < 1000 显示原值', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', tokens: 800 }))
    expect(lastFrame()).toContain('800 tok')
  })

  it('token >= 1000 显示 k', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', tokens: 1200 }))
    expect(lastFrame()).toContain('1.2k tok')
  })

  it('显示成本', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', cost: '¥0.003' }))
    expect(lastFrame()).toContain('¥0.003')
  })

  it('显示 MCP 段', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', mcp: 'MCP 2/3' }))
    expect(lastFrame()).toContain('MCP 2/3')
  })

  it('不含 warning（运行时告警由 App 层渲染为独立第二行）', () => {
    // warning prop 已从 StatusBar 移除——长告警（429 JSON）曾把本行与快捷键提示挤碎
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', tokens: 800 }))
    expect((lastFrame() ?? '').split('\n')).toHaveLength(1)
  })
})
