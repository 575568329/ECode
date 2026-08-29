import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { UserMessage } from '../../src/tui/UserMessage.js'
import { AssistantMessage } from '../../src/tui/AssistantMessage.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

describe('UserMessage', () => {
  it('灰 ❯ + 文本', () => {
    const { lastFrame } = render(React.createElement(UserMessage, { text: '你好世界' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('❯')
    expect(f).toContain('你好世界')
  })

  it('多行文本保留', () => {
    const { lastFrame } = render(React.createElement(UserMessage, { text: '第一行\n第二行' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('第一行')
    expect(f).toContain('第二行')
  })

  it('F-36 栅格（2026-08-29 用户拍板）：续行对齐内容列（padding 1 + 图标槽 2 → 第 3 列起），不顶格', () => {
    const { lastFrame } = render(React.createElement(UserMessage, { text: '第一行\n第二行' }))
    const f = lastFrame() ?? ''
    const lines = f.split('\n')
    const first = lines.find((l) => l.includes('第一行')) ?? ''
    const second = lines.find((l) => l.includes('第二行')) ?? ''
    expect(first).toContain('❯') // 首行：图标槽内 ❯
    expect(second.startsWith('   ')).toBe(true) // 续行：对齐内容列第 3 列，不回第 0 列
  })
})

describe('AssistantMessage', () => {
  it('committed：Markdown 渲染（标题）', () => {
    const { lastFrame } = render(React.createElement(AssistantMessage, { text: '# 标题内容' }))
    expect(lastFrame()).toContain('标题内容')
  })

  it('committed：纯文本（无语法）原样', () => {
    const { lastFrame } = render(React.createElement(AssistantMessage, { text: '普通回答文字' }))
    expect(lastFrame()).toContain('普通回答文字')
  })

  it('streaming：灰字占位显示文本', () => {
    const { lastFrame } = render(
      React.createElement(AssistantMessage, { text: '正在生成中', streaming: true }),
    )
    expect(lastFrame()).toContain('正在生成中')
  })

  it('streaming：长文本折叠（走 GrayStreaming）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i + 1}行`).join('\n')
    const { lastFrame } = render(React.createElement(AssistantMessage, { text, streaming: true }))
    const f = lastFrame() ?? ''
    expect(f).toContain('折叠')
    expect(f).toContain('第10行')
    expect(f).not.toContain('第1行')
  })
})
