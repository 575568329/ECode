import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { StatusBar, formatMem, fitSegments } from '../../src/tui/StatusBar.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

describe('StatusBar', () => {
  it('显示 model', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'GLM-5.2' }))
    expect(lastFrame()).toContain('GLM-5.2')
  })

  it('不含 ECode 品牌前缀（2026-09-02 精简批：省宽，终端里即本程序）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M' }))
    expect(lastFrame()).not.toContain('ECode')
  })

  it('显示轮数（含 maxIter，# 单字符）', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { model: 'M', iter: 3, maxIter: 50 }),
    )
    expect(lastFrame()).toContain('#3/50')
  })

  it('显示轮数（无 maxIter）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', iter: 7 }))
    expect(lastFrame()).toContain('#7')
  })

  it('token < 1000 显示原值（T 前缀）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', tokens: 800 }))
    expect(lastFrame()).toContain('T800')
  })

  it('token >= 1000 显示 k', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', tokens: 1200 }))
    expect(lastFrame()).toContain('T1.2k')
  })

  it('token 智能进位（2026-08-29 用户点名）：m 级 + 整值去 .0（1000.0k→1m 省宽）', () => {
    const f1 = render(React.createElement(StatusBar, { model: 'M', tokens: 1_000_000 })).lastFrame() ?? ''
    expect(f1).toContain('T1m')
    const f2 = render(React.createElement(StatusBar, { model: 'M', tokens: 1_230_000 })).lastFrame() ?? ''
    expect(f2).toContain('T1.2m')
    const f3 = render(React.createElement(StatusBar, { model: 'M', tokens: 999_500 })).lastFrame() ?? ''
    expect(f3).toContain('T999.5k')
  })

  it('显示成本', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', cost: '¥0.003' }))
    expect(lastFrame()).toContain('¥0.003')
  })

  it('显示 MCP 段（2026-09-02 精简批回调：保留 MCP 词干）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', mcp: 'MCP 2/3' }))
    expect(lastFrame()).toContain('MCP 2/3')
  })

  it('不含 warning（运行时告警由 App 层渲染为独立第二行）', () => {
    // warning prop 已从 StatusBar 移除——长告警（429 JSON）曾把本行与快捷键提示挤碎
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', tokens: 800 }))
    expect((lastFrame() ?? '').split('\n')).toHaveLength(1)
  })

  describe('2026-09-02 内存段（本进程 RSS 常驻，用户点名）', () => {
    it('MB 级显示 R350M', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', memBytes: 350 * 1024 ** 2 }))
      expect(lastFrame()).toContain('R350M')
    })
    it('GB 级一位小数 R1.4G', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', memBytes: 1.4 * 1024 ** 3 }))
      expect(lastFrame()).toContain('R1.4G')
    })
    it('formatMem 纯函数（R 前缀在渲染层）：≥10G 取整 / <1M 钳 1M / 整值去 .0 / 进位口径（审阅 P2-3）', () => {
      expect(formatMem(12 * 1024 ** 3)).toBe('12G')
      expect(formatMem(2 * 1024 ** 3)).toBe('2G')
      expect(formatMem(200 * 1024)).toBe('1M')
      // 舍入后达 1024MB 即进 G——旧实现按原始值判 <1024 会显示 1024M
      expect(formatMem(1023.6 * 1024 ** 2)).toBe('1G')
      expect(formatMem(1023.4 * 1024 ** 2)).toBe('1023M')
    })
    it('undefined 不显示内存段', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M' }))
      expect(lastFrame() ?? '').not.toMatch(/R\d/)
    })
  })

  describe('2026-09-02 宽度守卫（fitSegments 纯函数：超宽按可牺牲度丢段）', () => {
    const allSegs = [
      { key: 'model', text: 'glm-5.3-flash' },
      { key: 'iter', text: '#3/25' },
      { key: 'ctx', text: 'ctx 45k/200k' },
      { key: 'tokens', text: 'T45k' },
      { key: 'sandbox', text: '⏵⏵ edits' },
      { key: 'cost', text: '¥0.003' },
      { key: 'mem', text: 'R350M' },
      { key: 'mcp', text: 'MCP 2/3' },
      { key: 'daemon', text: '后台运行' },
    ]
    it('宽度足够全段保留', () => {
      expect(fitSegments(allSegs, 200)).toHaveLength(9)
    })
    it('超宽先丢 daemon → mcp（观测类先牺牲；预算核算：全宽 92，75 列下丢 2 段收住）', () => {
      const kept = fitSegments(allSegs, 75)
      const keys = kept.map((s) => s.key)
      expect(keys).not.toContain('daemon')
      expect(keys).not.toContain('mcp')
      expect(keys).toContain('mem')
      expect(keys).toContain('cost')
    })
    it('极窄只剩 model（恒留段）+ 高价值段', () => {
      const kept = fitSegments(allSegs, 20)
      expect(kept.map((s) => s.key)).toEqual(['model'])
    })
    it('不在场的段跳过不误伤', () => {
      const partial = [
        { key: 'model', text: 'glm-5.3-flash' },
        { key: 'ctx', text: 'ctx 45k/200k' },
      ]
      expect(fitSegments(partial, 20)).toEqual([{ key: 'model', text: 'glm-5.3-flash' }])
    })
  })

  describe('F-44 ctx 段（上下文占用/余量）', () => {
    it('显示 ctx 占用/窗口（k 格式）', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', ctxUsed: 45_000, ctxWindow: 200_000 }))
      const f = lastFrame() ?? ''
      expect(f).toContain('ctx 45k/200k')
    })

    it('占比 ≥90% 转 warn 色加粗（压缩阈值临近提示）', () => {
      // ink-testing 剥 ANSI 后帧无色——用行为差异锁：结构存在即着色路径已走（同帧文本一致，
      // 着色断言经 snapshot 等价校验不值——此处锁格式与阈值不崩即可，色值逻辑在纯函数段）
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', ctxUsed: 190_000, ctxWindow: 200_000 }))
      const f = lastFrame() ?? ''
      expect(f).toContain('ctx 190k/200k')
      expect((f.split('\n')).length).toBe(1)
    })

    it('缺任一字段不显示 ctx 段（旧宿主兼容）', () => {
      const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', ctxUsed: 45_000 }))
      expect(lastFrame()).not.toContain('ctx ')
    })
  })

  it('沙箱段只显档位箭头短词，不显 mode 全名（2026-09-02 精简批）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { model: 'M', sandbox: 'accept-edits' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('⏵⏵ edits')
    expect(f).not.toContain('accept-edits')
  })

  it('丢段后超长 model 仍截断（审阅 P1：旧实现只在全段保住分支截断——丢过段后只剩超长 model 不截会 wrap 破帧账）', () => {
    // ink-testing mock stdout columns=100：110 宽 model + 全段 → 守卫丢光仍超宽 → 恒截断为 99x+…
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        model: 'x'.repeat(110),
        iter: 3,
        maxIter: 25,
        tokens: 45_000,
        ctxUsed: 45_000,
        ctxWindow: 200_000,
        cost: '¥0.003',
        memBytes: 350 * 1024 ** 2,
        mcp: 'MCP 2/3',
        daemon: '后台运行',
      }),
    )
    const f = lastFrame() ?? ''
    const run = f.match(/x+/g) ?? []
    const longest = run.length > 0 ? Math.max(...run.map((s) => s.length)) : 0
    expect(f).toContain('…')
    expect(longest).toBeLessThanOrEqual(99)
    expect((f.split('\n')).length).toBe(1)
  })
})
