/**
 * /devices 面板二轮扩展（2026-09-04 用户点名「基础服务一套做好」）：
 *  - 附着态显示 本机服务地址 + 访问令牌（只读信息行）
 *  - 「停止后台 serve」动作（二次确认）→ 回调宿主停进程+降级本地
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { DevicesPanel } from '../../src/tui/DevicesPanel.js'

afterEach(() => cleanup())

describe('DevicesPanel：本机服务信息 + 停止 serve', () => {
  it('附着态：显示本机服务地址与访问令牌（只读信息行）', () => {
    const { lastFrame } = render(
      React.createElement(DevicesPanel, {
        serve: { address: 'http://127.0.0.1:56621', token: 'tok-abc123' },
        onStopServe: () => {},
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('本机服务  http://127.0.0.1:56621')
    expect(f).toContain('访问令牌  tok-abc123')
    expect(f).toContain('停止后台 serve')
  })

  it('embedded（无 serve）：不显示服务信息与停止行', () => {
    const { lastFrame } = render(React.createElement(DevicesPanel, {}))
    const f = lastFrame() ?? ''
    expect(f).not.toContain('本机服务')
    expect(f).not.toContain('停止后台 serve')
    expect(f).toContain('配对新设备')
  })

  it('停止 serve 二次确认：首次回车武装，再回车才回调（防误触）', async () => {
    let stopped = 0
    const { stdin, lastFrame } = render(
      React.createElement(DevicesPanel, {
        serve: { address: 'http://127.0.0.1:56621', token: 't' },
        onStopServe: () => {
          stopped += 1
        },
      }),
    )
    // 定位到「停止后台 serve」行：默认光标在第 0 行=stop 行（rows 首个 item）
    stdin.write('\r')
    await new Promise((r) => setTimeout(r, 60))
    expect(stopped).toBe(0) // 首次仅武装
    expect(lastFrame() ?? '').toContain('再回车确认')
    stdin.write('\r')
    await new Promise((r) => setTimeout(r, 60))
    expect(stopped).toBe(1) // 二次确认才真停
  })
})
