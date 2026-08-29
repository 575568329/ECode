import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import stringWidth from 'string-width'
import { Markdown, computeColWidths } from '../../src/tui/Markdown.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

/** 剥 ANSI 后按显示宽度测一行（中文 1 字 2 列），用于断言表格不超屏 */
const lineWidth = (line: string): number => stringWidth(line.replace(/\u001b\[[0-9;]*m/g, ''))

/** 与组件内 cols() 同式：终端更窄取终端宽，上限 100 */
const renderCols = (): number => Math.min(process.stdout.columns || 80, 100)

describe('computeColWidths 表格列宽分配', () => {
  it('自然宽合计在预算内 → 原样返回不折行', () => {
    expect(computeColWidths([4, 6], 50)).toEqual([4, 6])
  })

  it('超预算 → 短列保底不压、长列压缩、合计恰等于预算', () => {
    const widths = computeColWidths([4, 40, 100], 90)
    expect(widths[0]).toBe(4)
    expect(widths.reduce((a, b) => a + b, 0)).toBe(90)
    expect(widths.every((w) => w >= 1)).toBe(true)
    expect(widths[2]).toBeGreaterThan(widths[1])
    expect(widths[1]).toBeGreaterThan(10)
  })

  it('预算低于列数（终端过窄）→ 均分兜底每列至少 1', () => {
    const widths = computeColWidths([40, 30], 1)
    expect(widths).toEqual([1, 1])
  })

  it('空列集返回空数组', () => {
    expect(computeColWidths([], 50)).toEqual([])
  })
})

describe('Markdown 组件渲染', () => {
  it('纯文本（无语法）原样输出', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: 'hello 普通文字' }))
    expect(lastFrame()).toContain('hello 普通文字')
  })

  it('标题渲染', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '# 标题一' }))
    expect(lastFrame()).toContain('标题一')
  })

  it('段落含粗体内容', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '正文 **粗体** 结束' }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('正文')
    expect(frame).toContain('粗体')
    expect(frame).toContain('结束')
  })

  it('行内代码', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '用 `npm` 安装' }))
    expect(lastFrame()).toContain('npm')
  })

  it('无序列表', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '- 项一\n- 项二\n- 项三' }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('项一')
    expect(frame).toContain('项二')
    expect(frame).toContain('项三')
  })

  it('有序列表', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '1. 第一\n2. 第二' }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('第一')
    expect(frame).toContain('第二')
  })

  it('代码块（fallback 含 code 内容）', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '```js\nconst x = 1\n```' }))
    expect(lastFrame()).toContain('const x = 1')
  })

  it('表格渲染', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { text: '| 姓名 | 分数 |\n|---|---|\n| 张三 | 90 |' }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('姓名')
    expect(frame).toContain('张三')
    expect(frame).toContain('90')
  })

  it('窄表格不折行（数据行单行呈现）', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { text: '| 姓名 | 分数 |\n|---|---|\n| 张三 | 90 |' }),
    )
    const lines = (lastFrame() ?? '').split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))
    const dataLine = lines.find((l) => l.includes('张三'))
    expect(dataLine).toBeDefined()
    expect(dataLine).toContain('90')
  })

  it('超宽表格按终端宽自适应（单元格内折行 ≤4 行，边框不再超屏）', () => {
    // 复刻事故形态：长接口路径 + 文件路径 + 超宽中文描述（80 显示宽，折 3 行不触发降级）
    const longDesc = '描述文字'.repeat(10)
    const md = [
      '| 接口 | 定义处 | 作用 |',
      '|---|---|---|',
      `| GET api/presBasic/getRppQuestion?taskId= | src/api/basicResService.js:16 | ${longDesc} |`,
      `| GET api/task/getTaskDetail?taskId= | src/api/taskService.js:27 | ${longDesc} |`,
    ].join('\n')
    const { lastFrame } = render(React.createElement(Markdown, { text: md }))
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    // 每行显示宽度都不超渲染宽——修复前长描述列会把行撑到 200+ 列被终端软折行打碎边框
    for (const line of lines) {
      expect(lineWidth(line)).toBeLessThanOrEqual(renderCols())
    }
    // 保持表格形态（未被降级）：边框在，且无截断符 …（截断才会丢字符）
    expect(frame).toContain('┌')
    expect(frame).toContain('│')
    expect(frame).not.toContain('…')
    expect(frame).toContain('GET api/presBa')
    // URL 断在语义边界（…/getRppQuestion? 整段一行），不是任意字符拦腰切
    expect(frame).toContain('getRppQuestion?')
    expect(frame).toContain('描述文字')
    // 长描述在单元格内折行 → 行数远多于 2 条数据行
    expect(lines.length).toBeGreaterThan(6)
  })

  it('折行超限的表格降级为 key-value 垂直格式', () => {
    // 描述 320 显示宽，按分配列宽折行 8 行 > 4 → 整表转 key-value
    const hugeDesc = '描述文字'.repeat(40)
    const md = [
      '| 接口 | 定义处 | 作用 |',
      '|---|---|---|',
      `| GET api/presBasic/getRppQuestion?taskId= | src/api/basicResService.js:16 | ${hugeDesc} |`,
      `| GET api/task/getTaskDetail?taskId= | src/api/taskService.js:27 | ${hugeDesc} |`,
    ].join('\n')
    const { lastFrame } = render(React.createElement(Markdown, { text: md }))
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    // 无表格边框（已降级），标签 key-value 形态 + 记录间分隔线
    const plain = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))
    for (const line of plain) {
      expect(line).not.toContain('│')
      expect(line).not.toContain('┌')
    }
    expect(plain.some((l) => l.startsWith('接口: '))).toBe(true)
    // 垂直形态行宽 ~74：URL 整条放得下，保持完整不拆（codex adaptive wrap 同语义）
    expect(plain.some((l) => l.includes('GET api/presBasic/getRppQuestion?taskId='))).toBe(true)
    expect(plain.some((l) => l.startsWith('定义处: '))).toBe(true)
    expect(plain.some((l) => l.startsWith('作用: '))).toBe(true)
    expect(frame).toContain('─')
    expect(frame).toContain('描述文字')
    // 垂直形态同样不超屏（标签 + ': ' 前缀 + 值悬挂缩进对齐）
    for (const line of lines) {
      expect(lineWidth(line)).toBeLessThanOrEqual(renderCols())
    }
  })

  it('引用块', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '> 这是一句引用' }))
    expect(lastFrame()).toContain('这是一句引用')
  })

  it('分隔线', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '上文\n\n---\n\n下文' }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('上文')
    expect(frame).toContain('下文')
    expect(frame).toContain('─')
  })

  it('中文长文本按显示宽度折行', () => {
    const longText = '这是一段需要被折行的中文长文本内容'.repeat(8)
    const { lastFrame } = render(React.createElement(Markdown, { text: longText }))
    const frame = lastFrame() ?? ''
    // cols 上限 100，原文远超 100 显示宽度，应被折成多行
    expect(frame.split('\n').length).toBeGreaterThan(1)
  })

  it('链接 M2 纯文本 linkify', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { text: '见 [文档](http://example.com) 了解' }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('文档')
    expect(frame).toContain('http://example.com')
  })

  it('复杂混合文档', () => {
    const md = [
      '# ECode 介绍',
      '',
      'ECode 是一个**终端 Agent CLI**，用 `TypeScript` 写的。',
      '',
      '## 特性',
      '',
      '- AgentLoop 心脏',
      '- Ink TUI',
      '- 多 Provider 支持',
      '',
      '```ts',
      'const loop = new AgentLoop(config)',
      '```',
      '',
      '> 简洁优先。',
    ].join('\n')
    const { lastFrame } = render(React.createElement(Markdown, { text: md }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('ECode 介绍')
    expect(frame).toContain('终端 Agent CLI')
    expect(frame).toContain('AgentLoop 心脏')
    expect(frame).toContain('const loop')
    expect(frame).toContain('简洁优先')
  })
})
