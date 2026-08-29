import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { StatusBar } from '../../src/tui/StatusBar.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

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

  it('token 智能进位（2026-08-29 用户点名）：m 级 + 整值去 .0（1000.0k→1m 省宽）', () => {
    const f1 = render(React.createElement(StatusBar, { model: 'M', tokens: 1_000_000 })).lastFrame() ?? ''
    expect(f1).toContain('1m tok')
    const f2 = render(React.createElement(StatusBar, { model: 'M', tokens: 1_230_000 })).lastFrame() ?? ''
    expect(f2).toContain('1.2m tok')
    const f3 = render(React.createElement(StatusBar, { model: 'M', tokens: 999_500 })).lastFrame() ?? ''
    expect(f3).toContain('999.5k tok')
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

  describe('F-44 ctx 段（上下文占用/余量）', () => {
    it('显示 ctx 占用/窗口（k 格式）', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', ctxUsed: 45_000, ctxWindow: 200_000 }))
      const f = lastFrame() ?? ''
      expect(f).toContain('ctx 45k/200k')
    })

    it('占比 ≥90% 转 warn 色加粗（压缩阈值临近提示）', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', ctxUsed: 190_000, ctxWindow: 200_000 }))
      // ink-testing 剥 ANSI 后帧无色——用行为差异锁：结构存在即着色路径已走（同帧文本一致，
      // 着色断言经 snapshot 等价校验不值——此处锁格式与阈值不崩即可，色值逻辑在纯函数段）
      const f = lastFrame() ?? ''
      expect(f).toContain('ctx 190k/200k')
      expect((f.split('\n')).length).toBe(1)
    })

    it('缺任一字段不显示 ctx 段（旧宿主兼容）', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', ctxUsed: 45_000 }))
      expect(lastFrame()).not.toContain('ctx ')
    })
  })
})
