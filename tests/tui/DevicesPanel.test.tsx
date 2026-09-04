/**
 * /devices 面板单测（隔离版——2026-09-04 测试席 P1：原版真读本机 server.json+真打活 daemon，
 * flake 种子+渲染开发者真实设备）。隔离面：fetch 全局 mock（health/devices）+ pairing mock
 * （误触发配对时立即抛错防写真实注册表）。
 * 覆盖：附着态服务信息+token 遮蔽/揭示切换；embedded 不渲染服务行/停止行；停止二次确认；
 * 光标移动解除武装；Esc 清武装不关面板。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { DevicesPanel } from '../../src/tui/DevicesPanel.js'
import type { ServeInfo } from '../../src/tui/DevicesPanel.js'

vi.mock('../../src/server/pairing.js', () => ({
  createPairingFull: vi.fn(async () => {
    throw new Error('测试不应真触发配对（光标误导航事故）')
  }),
}))

const TEST_DEVICES = [
  { deviceId: 'dev-1', name: '手机A', scope: 'chat', pairedAt: '2026-09-04T00:00:00.000Z' },
  { deviceId: 'dev-2', name: '平板B', scope: 'full', pairedAt: '2026-09-04T00:00:00.000Z' },
]

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const serveInfo: ServeInfo = {
  address: 'http://127.0.0.1:59999',
  token: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4',
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/api/health')) return { ok: true, json: async () => ({ ok: true }) } as never
    if (u.includes('/api/devices')) return { ok: true, json: async () => ({ devices: TEST_DEVICES }) } as never
    return { ok: true, json: async () => ({}) } as never
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('DevicesPanel：本机服务信息 + token 遮蔽 + 停止 serve', () => {
  it('附着态：显示本机服务地址；token 默认遮蔽（首尾可见中间掩码）', async () => {
    const { lastFrame } = render(React.createElement(DevicesPanel, { serve: serveInfo, onStopServe: () => {} }))
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('本机服务  http://127.0.0.1:59999'), { timeout: 3000 })
    const f = lastFrame() ?? ''
    expect(f).toContain('a1b2c3d4…e3f4') // 遮蔽形态
    expect(f).not.toContain(serveInfo.token) // 明文不上屏（scrollback/截屏面）
    expect(f).toContain('停止后台 serve')
  })

  it('token 行回车切换揭示/重新遮蔽（安全席 P1 显式揭示交互）', async () => {
    const { stdin, lastFrame } = render(React.createElement(DevicesPanel, { serve: serveInfo, onStopServe: () => {} }))
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('访问令牌'), { timeout: 3000 })
    // 光标默认在首 item=token 行：回车揭示
    stdin.write('\r')
    await sleep(80)
    expect(lastFrame() ?? '').toContain(serveInfo.token) // 明文揭示
    expect(lastFrame() ?? '').toContain('回车重新遮蔽')
    stdin.write('\r')
    await sleep(80)
    expect(lastFrame() ?? '').toContain('a1b2c3d4…e3f4') // 再回车重新遮蔽
    expect(lastFrame() ?? '').not.toContain(serveInfo.token)
  })

  it('embedded（无 serve）：不显示服务信息/token/停止行', () => {
    const { lastFrame } = render(React.createElement(DevicesPanel, {}))
    const f = lastFrame() ?? ''
    expect(f).not.toContain('本机服务')
    expect(f).not.toContain('访问令牌')
    expect(f).not.toContain('停止后台 serve')
    expect(f).toContain('配对新设备')
  })

  it('停止 serve 二次确认：首次回车武装，再回车才回调（防误触）', async () => {
    let stopped = 0
    const { stdin, lastFrame } = render(
      React.createElement(DevicesPanel, { serve: serveInfo, onStopServe: () => { stopped += 1 } }),
    )
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('停止后台 serve'), { timeout: 3000 })
    stdin.write('[B') // ↓ token 行是首 item——导航到停止行
    await sleep(60)
    // 光标默认在首 item=停止行
    stdin.write('\r')
    await sleep(60)
    expect(stopped).toBe(0) // 首次仅武装
    expect(lastFrame() ?? '').toContain('再回车确认')
    stdin.write('\r')
    await sleep(60)
    expect(stopped).toBe(1) // 二次确认才真停
  })

  it('光标移动解除武装（正确性席 P2：armed 行被隐藏后单回车误执行面消除）', async () => {
    let stopped = 0
    const { stdin, lastFrame } = render(
      React.createElement(DevicesPanel, { serve: serveInfo, onStopServe: () => { stopped += 1 } }),
    )
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('停止后台 serve'), { timeout: 3000 })
    stdin.write('[B') // ↓ token 行是首 item——导航到停止行
    await sleep(60)
    stdin.write('\r') // 武装停止
    await sleep(60)
    expect(lastFrame() ?? '').toContain('再回车确认')
    stdin.write('\u001b[B') // ↓ 离开（光标移动=解除武装）
    await sleep(60)
    expect(lastFrame() ?? '').not.toContain('再回车确认')
    stdin.write('\u001b[B') // 再 ↓
    await sleep(60)
    stdin.write('\r') // 此时回车落在其他行——不执行停止
    await sleep(120)
    expect(stopped).toBe(0)
  })

  it('Esc 清武装不关面板（文案宣称「Esc 取消」的回归锁）', async () => {
    const { stdin, lastFrame } = render(React.createElement(DevicesPanel, { serve: serveInfo, onStopServe: () => {} }))
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('停止后台 serve'), { timeout: 3000 })
    stdin.write('[B') // ↓ token 行是首 item——导航到停止行
    await sleep(60)
    stdin.write('\r') // 武装
    await sleep(60)
    expect(lastFrame() ?? '').toContain('再回车确认')
    stdin.write('\u001b') // Esc
    await sleep(60)
    expect(lastFrame() ?? '').not.toContain('再回车确认')
    expect(lastFrame() ?? '').toContain('停止后台 serve') // 面板未关
  })
})
