/** McpPanel（M6 T3）：三级导航/状态着色行/错误展开/操作菜单。 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { McpPanel } from '../../src/tui/McpPanel.js'
import type { McpServerSnapshot } from '../../src/services/mcp/manager.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

function snap(name: string, status: McpServerSnapshot['status'], over: Partial<McpServerSnapshot> = {}): McpServerSnapshot {
  return {
    name,
    status,
    source: 'user',
    type: 'stdio',
    toolCount: 3,
    lifecycle: 'lazy',
    ...over,
  }
}

const onReconnect = vi.fn(async () => {})
const onDisconnect = vi.fn(async () => {})

function P(snapshots: McpServerSnapshot[]): ReturnType<typeof render> {
  return render(
    React.createElement(McpPanel, {
      snapshots,
      onReconnect,
      onDisconnect,
      onCancel: () => {},
      toolsOf: (n) => [
        { name: `${n}__read`, description: '读' },
        { name: `${n}__write`, description: '写' },
      ],
    }),
  )
}

beforeEach(() => {
  onReconnect.mockClear()
  onDisconnect.mockClear()
})

describe('McpPanel 一级列表', () => {
  it('状态标签 + 工具数渲染', () => {
    const { lastFrame } = P([
      snap('fs', 'connected'),
      snap('db', 'failed', { error: 'spawn npx ENOENT', failedAgoSec: 12 }),
      snap('search', 'disabled'),
    ])
    const f = lastFrame() ?? ''
    expect(f).toContain('fs')
    expect(f).toContain('✓ 已连接')
    expect(f).toContain('✗ 失败')
    expect(f).toContain('12 秒前')
    expect(f).toContain('3 个工具')
    expect(f).toContain('⊘ 已禁用')
    expect(f).toContain('ctrl+r')
  })

  it('failed 行错误自动展开（≤4 行 + reconnect 提示）', async () => {
    const { lastFrame } = P([snap('db', 'failed', { error: 'spawn npx ENOENT 详细原因很长'.repeat(30), failedAgoSec: 5 })])
    await flush()
    await flush() // onCursor effect → setCursorName → 重渲染级联（30ms×2）
    const f = lastFrame() ?? ''
    expect(f).toContain('spawn npx')
    expect(f).toContain('/mcp reconnect db')
  })

  it('Enter → 详情视图（信息区 + 操作菜单）；Esc 回列表', async () => {
    const { stdin, lastFrame } = P([snap('fs', 'connected')])
    await flush()
    stdin.write('\r')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('lifecycle')
    expect(f).toContain('查看工具')
    expect(f).toContain('重连')
    expect(f).toContain('断开')
    stdin.write('\u001b')
    await flush()
    expect(lastFrame() ?? '').toContain('MCP 服务') // 回列表
  })

  it('详情 → 查看工具 → 三级列表；Esc 逐级回退', async () => {
    const { stdin, lastFrame } = P([snap('fs', 'connected')])
    await flush()
    stdin.write('\r') // 进详情
    await flush()
    stdin.write('\r') // 选中「查看工具」
    await flush()
    expect(lastFrame() ?? '').toContain('fs__read')
    stdin.write('\u001b') // 回详情
    await flush()
    expect(lastFrame() ?? '').toContain('lifecycle')
  })

  it('详情 → 断开 → onDisconnect', async () => {
    const { stdin } = P([snap('fs', 'connected')])
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\u001b[B\u001b[B') // ↓↓ 到「断开」（第 3 项，Select 初始在第 1 项）
    await flush()
    stdin.write('\r')
    await flush()
    expect(onDisconnect).toHaveBeenCalledWith('fs')
  })

  it('禁用 server：Enter 不进详情', async () => {
    const { stdin, lastFrame } = P([snap('off', 'disabled')])
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('MCP 服务') // 仍在列表
  })

  it('空配置：空态提示', () => {
    const { lastFrame } = P([])
    expect(lastFrame() ?? '').toContain('未配置 MCP server')
  })
})
