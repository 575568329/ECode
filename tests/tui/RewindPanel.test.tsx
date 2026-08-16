/**
 * RewindPanel 测（M9-P2）：mock CheckpointStore，聚焦二级确认页与守卫
 * （列表交互由 PanelShell 套件覆盖）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { RewindPanel } from '../../src/tui/RewindPanel.js'
import type { CheckpointMeta, CheckpointStore, RevertResult } from '../../src/services/checkpoint.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

function meta(seq: number, tool: string, files: string[]): CheckpointMeta {
  return { seq, time: `2026-08-16T1${seq}:30:00Z`, tool, files: files.map((p) => ({ path: p, hash: `h${seq}` })) }
}

function makeStore(metas: CheckpointMeta[], external: string[] = []): {
  store: CheckpointStore
  revert: ReturnType<typeof vi.fn>
} {
  const revert = vi.fn(async (): Promise<RevertResult> => ({ restored: metas.map((m) => m.files[0]?.path ?? ''), externalChanged: external }))
  const store = {
    list: vi.fn(async () => metas),
    detectExternalChanges: vi.fn(async () => external),
    revert,
  } as unknown as CheckpointStore
  return { store, revert }
}

function panel(store: CheckpointStore, disabled = false, onDone = vi.fn()) {
  return render(
    React.createElement(RewindPanel, { store, sessionId: 's1', disabled, onDone }),
  )
}

describe('RewindPanel（M9-P2）', () => {
  it('列表：最新在上 + 行摘要（HH:MM 工具 文件）+ 空态提示', async () => {
    const { store } = makeStore([meta(1, 'write_file', ['a.ts']), meta(2, 'edit_file', ['b.ts', 'c.ts'])])
    const { lastFrame } = panel(store)
    await flush()
    const f = lastFrame() ?? ''
    expect(f.indexOf('edit_file')).toBeLessThan(f.indexOf('write_file')) // seq2 在上
    expect(f).toContain('b.ts、c.ts')
    // 空态
    const empty = makeStore([])
    const { lastFrame: lf2 } = panel(empty.store)
    await flush()
    expect(lf2() ?? '').toContain('本会话还没有任何改动')
  })

  it('文件摘要 >3 个 → +N', async () => {
    const { store } = makeStore([meta(1, 'bash', ['a', 'b', 'c', 'd', 'e'])])
    const { lastFrame } = panel(store)
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('a、b、c +2')
  })

  it('Enter → 二级页列文件清单；外部修改文件 ⚠ 标注', async () => {
    const { store } = makeStore([meta(1, 'edit_file', ['x/a.ts', 'x/b.ts'])], ['x/b.ts'])
    const { stdin, lastFrame } = panel(store)
    await flush()
    stdin.write('\r')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('将还原以下文件')
    expect(f).toContain('x/a.ts')
    expect(f).toContain('⚠ x/b.ts')
    expect(f).toContain('还原将覆盖')
    expect(f).toContain('y 还原')
  })

  it('disabled（运行中）→ 二级页可见但 y 不触发 revert', async () => {
    const { store, revert } = makeStore([meta(1, 'edit_file', ['a.ts'])])
    const { stdin, lastFrame } = panel(store, true)
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('本轮运行结束后才能回退')
    stdin.write('y')
    await flush()
    expect(revert).not.toHaveBeenCalled()
  })

  it('y → revert(选中点) + onDone(seq, restoredCount)', async () => {
    const { store, revert } = makeStore([meta(1, 'edit_file', ['a.ts']), meta(2, 'bash', ['b.ts'])])
    const onDone = vi.fn()
    const { stdin } = render(
      React.createElement(RewindPanel, { store, sessionId: 's1', disabled: false, onDone }),
    )
    await flush()
    stdin.write('\r') // 选最新（seq2 在上）
    await flush()
    stdin.write('y')
    await flush()
    await flush()
    expect(revert).toHaveBeenCalledWith('s1', 2)
    expect(onDone).toHaveBeenCalledWith({ seq: 2, restoredCount: 2, toolUseId: undefined })
  })

  it('二级页 Esc → 退回列表；列表页 Esc → onDone(null)', async () => {
    const { store } = makeStore([meta(1, 'edit_file', ['a.ts'])])
    const onDone = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(RewindPanel, { store, sessionId: 's1', disabled: false, onDone }),
    )
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\u001b') // 退回列表
    await flush()
    expect(lastFrame() ?? '').toContain('回退到哪个改动之前')
    expect(onDone).not.toHaveBeenCalled()
    stdin.write('\u001b') // 列表页关闭
    await flush()
    expect(onDone).toHaveBeenCalledWith(null)
  })
})
