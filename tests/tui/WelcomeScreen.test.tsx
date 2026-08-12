import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { WelcomeScreen } from '../../src/tui/WelcomeScreen.js'

describe('WelcomeScreen', () => {
  it('显示 ECode 品牌', () => {
    const { lastFrame } = render(React.createElement(WelcomeScreen, {}))
    expect(lastFrame()).toContain('ECode')
  })

  it('version/model/cwd', () => {
    const { lastFrame } = render(
      React.createElement(WelcomeScreen, { version: '0.1.0', model: 'GLM-5.2', cwd: 'D:\\proj' }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('v0.1.0')
    expect(f).toContain('GLM-5.2')
    expect(f).toContain('D:\\proj')
  })

  it('无 error 显示引导', () => {
    const { lastFrame } = render(React.createElement(WelcomeScreen, {}))
    expect(lastFrame()).toContain('/help')
  })

  it('有 error 显示 ✗', () => {
    const { lastFrame } = render(
      React.createElement(WelcomeScreen, { error: '缺少 API Key' }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('✗')
    expect(f).toContain('缺少 API Key')
  })
})
