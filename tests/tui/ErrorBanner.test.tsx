import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { ErrorBanner } from '../../src/tui/ErrorBanner.js'
import type { AppError } from '../../src/core/types.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

function makeError(over: Partial<AppError> = {}): AppError {
  return {
    code: 'INTERNAL',
    message: '出错了',
    recoverable: false,
    ...over,
  } as AppError
}

describe('ErrorBanner', () => {
  it('显示 ✗ + message', () => {
    const { lastFrame } = render(React.createElement(ErrorBanner, { error: makeError({ message: '网络失败' }) }))
    const f = lastFrame() ?? ''
    expect(f).toContain('✗')
    expect(f).toContain('网络失败')
  })

  it('显示 code', () => {
    const { lastFrame } = render(React.createElement(ErrorBanner, { error: makeError({ code: 'TIMEOUT' }) }))
    expect(lastFrame()).toContain('TIMEOUT')
  })

  it('中文 message 完整', () => {
    const { lastFrame } = render(
      React.createElement(ErrorBanner, { error: makeError({ message: '上下文长度超限，请用 /clear' }) }),
    )
    expect(lastFrame()).toContain('上下文长度超限')
  })
})
