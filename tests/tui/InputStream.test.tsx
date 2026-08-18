import { describe, it, expect, beforeEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { SlashSuggest, InputStream } from '../../src/tui/InputStream.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'

beforeEach(() => {
  commandRegistry.clear()
  registerBuiltinCommands()
})

describe('SlashSuggest', () => {
  it('/he 显示 /help', () => {
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/he' }))
    expect(lastFrame()).toContain('/help')
  })

  it('/c 显示 /clear', () => {
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/c' }))
    expect(lastFrame()).toContain('/clear')
  })

  it('非 / 开头不显示', () => {
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: 'hello' }))
    expect(lastFrame() ?? '').toBe('')
  })

  it('只有 / 显示全部命令', () => {
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('/help')
    expect(f).toContain('/clear')
  })

  it('无匹配不显示', () => {
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/xyz' }))
    expect(lastFrame() ?? '').toBe('')
  })

  it('列出多个匹配（/h → help/history 若有）', () => {
    commandRegistry.register({ name: 'history', description: '', run: () => ({}) })
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/h' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('/help')
    expect(f).toContain('/history')
  })
})

describe('InputStream', () => {
  it('渲染不崩（含 ❯ 提示符）', () => {
    const { lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {} }),
    )
    expect(lastFrame()).toContain('❯')
  })

  it('placeholder 透传', () => {
    const { lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, placeholder: '说点什么...' }),
    )
    expect(lastFrame()).toContain('说点什么...')
  })
})

describe('InputStream 附件行（M10 修复批：待发送图片常驻输入区）', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

  it('attachments 非空 → 输入框上方渲染附件标签 + 发送提示', () => {
    const { lastFrame } = render(
      React.createElement(InputStream, {
        onSubmit: () => {},
        attachments: ['[图片#1 PNG 9.9KB]', '[图片#2 PNG 3.1KB]'],
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('[图片#1 PNG 9.9KB]')
    expect(f).toContain('[图片#2 PNG 3.1KB]')
    expect(f).toContain('（回车随消息发送）')
  })

  it('attachments 空/缺省 → 不渲染附件行', () => {
    const a = render(React.createElement(InputStream, { onSubmit: () => {}, attachments: [] }))
    expect(a.lastFrame() ?? '').not.toContain('回车随消息发送')
    const b = render(React.createElement(InputStream, { onSubmit: () => {} }))
    expect(b.lastFrame() ?? '').not.toContain('回车随消息发送')
  })

  it('空文本 + 有附件 → 回车放行（onSubmit 收到空串，图片即消息内容）', async () => {
    const calls: string[] = []
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: (t) => {
          calls.push(t)
        },
        attachments: ['[图片#1 PNG 9.9KB]'],
      }),
    )
    stdin.write('\r')
    await flush()
    expect(calls).toEqual([''])
  })

  it('空文本 + 无附件 → 回车仍拦截（原行为不回归）', async () => {
    const calls: string[] = []
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: (t) => {
          calls.push(t)
        },
      }),
    )
    stdin.write('\r')
    await flush()
    expect(calls).toEqual([])
  })

  it('有文本 + 有附件 → 回车提交文本（附件由 TuiApp 组装，InputStream 只管文本流）', async () => {
    const calls: string[] = []
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: (t) => {
          calls.push(t)
        },
        attachments: ['[图片#1 PNG 9.9KB]'],
      }),
    )
    stdin.write('看下这张图')
    await flush()
    stdin.write('\r')
    await flush()
    expect(calls).toEqual(['看下这张图'])
  })
})
