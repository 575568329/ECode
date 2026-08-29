/**
 * 插话键路测试（M11 审阅修复批 P0-1/P1-5）：斜杠忙碌态拦截必须在 InputStream 分流点生效
 * （TuiApp.submit 里的守卫不可达——InputStream 组件内就分流了斜杠，审阅 P0-1 的教训：
 * 该测试走真实键路，不走 submit() 直调的自欺路径）。
 */
import {describe, it, expect, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { InputStream } from '../../src/tui/InputStream.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('M11 插话：InputStream 键路', () => {
  it('忙碌态斜杠命令：onSlashBusy 被调、命令不执行不排队（P0-1）', async () => {
    const onSlashBusy = vi.fn()
    const onCommand = vi.fn()
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, {
        onSubmit,
        onCommand,
        onSlashBusy,
        busy: true,
      }),
    )
    stdin.write('/不存在的命令xyz')
    await sleep(30)
    stdin.write('\r')
    await sleep(30)
    expect(onSlashBusy).toHaveBeenCalledTimes(1)
    expect(onCommand).not.toHaveBeenCalled() // 命令未执行
    expect(onSubmit).not.toHaveBeenCalled() // 未走文本提交
  })

  it('空闲态斜杠命令照常执行（busy 不影响正常命令）', async () => {
    const onSlashBusy = vi.fn()
    const onCommand = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: () => {},
        onCommand,
        onSlashBusy,
        busy: false,
      }),
    )
    stdin.write('/不存在的命令xyz')
    await sleep(30)
    stdin.write('\r')
    await sleep(30)
    expect(onCommand).toHaveBeenCalledTimes(1) // 走了命令分流（未知命令提示）
    expect(onSlashBusy).not.toHaveBeenCalled()
  })

  it('Ctrl+U 触发 onInterjectClear（与 busy 无关，空闲态也清）', async () => {
    const onInterjectClear = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: () => {},
        onInterjectClear,
      }),
    )
    stdin.write('\x15')
    await sleep(30)
    expect(onInterjectClear).toHaveBeenCalledTimes(1)
  })

  it('忙碌态普通文本：onSubmit 照常（分流到插话由 TuiApp.submit 决定）', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit,
        busy: true,
      }),
    )
    stdin.write('改用方案B')
    await sleep(30)
    stdin.write('\r')
    await sleep(30)
    expect(onSubmit).toHaveBeenCalledWith('改用方案B')
  })
})
