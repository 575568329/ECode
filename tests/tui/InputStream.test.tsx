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
