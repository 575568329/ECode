/** SandboxPanel 测（M9-P4）：四档列表/Tab 循环/full-access 二级确认/Enter 选定。 */
import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { SandboxPanel } from '../../src/tui/SandboxPanel.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 40))
const TAB = '\t'

function panel(current: 'default' | 'full-access' = 'default') {
  const onPick = vi.fn()
  const r = render(React.createElement(SandboxPanel, { current, onPick }))
  return { ...r, onPick }
}

describe('SandboxPanel', () => {
  it('四档列表 + 说明 + 当前档标记', () => {
    const { lastFrame } = panel('default')
    const f = lastFrame() ?? ''
    for (const m of ['default', 'read-only', 'workspace-write', 'full-access']) expect(f).toContain(m)
    expect(f).toContain('(当前)')
    expect(f).toContain('全部免确认')
  })

  it('Tab 循环下移 + 环绕（default → accept-edits → read-only → ... → full-access → default）', async () => {
    const { stdin, lastFrame } = panel('default')
    stdin.write(TAB)
    await flush()
    expect(lastFrame() ?? '').toContain('纯编辑（edit_file/write_file）免确认放行') // 界面批 C1：default 后第一档是 accept-edits
    stdin.write(TAB)
    await flush()
    expect(lastFrame() ?? '').toContain('read-only —— write/edit/bash 全部拒绝；读类照常') // 选中态显示完整说明（非 dimColor）
  })

  it('Enter 选定非 full-access → onPick(该档)', async () => {
    const { stdin, onPick } = panel('default')
    stdin.write(TAB) // → accept-edits
    stdin.write(TAB) // → read-only
    await flush()
    stdin.write('\r')
    await flush()
    expect(onPick).toHaveBeenCalledWith('read-only')
  })

  it('Enter 选 full-access → 二级确认页；y 生效 / Esc 返回', async () => {
    const { stdin, lastFrame, onPick } = panel('default')
    // Tab×4 → full-access（五档：default→accept-edits→read-only→workspace-write→full-access）
    for (let i = 0; i < 4; i++) {
      stdin.write(TAB)
      await flush()
    }
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('进入 full-access')
    expect(onPick).not.toHaveBeenCalled()
    stdin.write('y')
    await flush()
    expect(onPick).toHaveBeenCalledWith('full-access')
  })

  it('当前已是 full-access 再 Enter → 直接选定（无需二次确认）', async () => {
    const { stdin, onPick } = panel('full-access')
    stdin.write('\r')
    await flush()
    expect(onPick).toHaveBeenCalledWith('full-access')
  })

  it('Esc → onPick(null) 取消', async () => {
    const { stdin, onPick } = panel('default')
    stdin.write('\u001b')
    await flush()
    expect(onPick).toHaveBeenCalledWith(null)
  })
})
