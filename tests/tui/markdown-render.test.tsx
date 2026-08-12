import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Markdown } from '../../src/tui/Markdown.js'

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
