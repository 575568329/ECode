import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { SlashSuggest, InputStream } from '../../src/tui/InputStream.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'

afterEach(() => cleanup()) // 遗留挂载实例会让后续实例的 promise 微任务渲染掉帧（界面批实证）——逐测卸载根治

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

describe('InputStream 图片标签内嵌（M10 真机修复批 v2：标签即输入文本，两家同款）', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

  it('Alt+V 粘贴成功 → 短标签插入输入框文本（光标处，带尾随空格）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, {
        onSubmit: () => {},
        onPasteImage: async () => '[图片#1]',
      }),
    )
    await flush()
    stdin.write('\x1bv')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('[图片#1]')
    expect(f).not.toContain('已粘贴') // v1 的 systemMsgs 提示与 v2 的附件行都不存在
  })

  it('Alt+V 已有文本 → 标签插在文本流中（一起显示在输入框内）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, {
        onSubmit: () => {},
        onPasteImage: async () => '[图片#1]',
      }),
    )
    await flush()
    stdin.write('看下')
    await flush()
    stdin.write('\x1bv')
    await flush()
    expect(lastFrame() ?? '').toContain('看下[图片#1]')
  })

  it('Alt+V 无图（返回 null）→ 输入框不变、不插标签', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, {
        onSubmit: () => {},
        onPasteImage: async () => null,
      }),
    )
    await flush()
    stdin.write('\x1bv')
    await flush()
    expect(lastFrame() ?? '').not.toContain('[图片#1]')
  })

  it('空文本回车仍拦截（标签在文本里，纯图消息文本非空——原空守卫回归）', async () => {
    const calls: string[] = []
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: (t) => {
          calls.push(t)
        },
      }),
    )
    await flush()
    stdin.write('\r')
    await flush()
    expect(calls).toEqual([])
  })

  it('删掉标签文本 → 提交的就是纯文本（剪枝在 TuiApp 组装侧，此处只验文本流）', async () => {
    const calls: string[] = []
    const { stdin } = render(
      React.createElement(InputStream, {
        onSubmit: (t) => {
          calls.push(t)
        },
        onPasteImage: async () => '[图片#1]',
      }),
    )
    await flush()
    stdin.write('\x1bv')
    await flush()
    // '[图片#1] ' 共 8 字素，逐个退格删净
    for (let i = 0; i < 8; i++) {
      stdin.write('\x7f')
      await flush()
    }
    stdin.write('hi')
    await flush()
    stdin.write('\r')
    await flush()
    expect(calls).toEqual(['hi'])
  })
})
