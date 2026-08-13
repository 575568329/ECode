import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { HistoryPicker } from '../../src/tui/HistoryPicker.js'
import type { SessionMeta } from '../../src/services/history.js'

const metas: SessionMeta[] = [
  { sessionId: 's1', createdAt: '2026-08-13T10:00:00.000Z', model: 'glm-5.2', firstUser: '帮我写个函数' },
  { sessionId: 's2', createdAt: '2026-08-13T09:00:00.000Z', model: 'deepseek-v4', firstUser: '解释这段代码' },
]

describe('HistoryPicker', () => {
  it('渲染 title + 会话列表（firstUser/时间/model）', () => {
    const { lastFrame } = render(
      React.createElement(HistoryPicker, { metas, onSelect: () => {}, onCancel: () => {} }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('恢复历史会话')
    expect(f).toContain('帮我写个函数')
    expect(f).toContain('glm-5.2')
    expect(f).toContain('解释这段代码')
    expect(f).toContain('deepseek-v4')
    expect(f).toContain('2026-08-13 10:00') // formatTime
  })

  it('回车 → onSelect(首项=最新会话 sessionId)', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(HistoryPicker, { metas, onSelect, onCancel: () => {} }),
    )
    stdin.write('\r')
    // loadAll 倒序，最新 s1 在第一项 → 初始光标
    expect(onSelect).toHaveBeenCalledWith('s1')
  })

  it('空列表 → 显示「无历史会话」', () => {
    const { lastFrame } = render(
      React.createElement(HistoryPicker, { metas: [], onSelect: () => {}, onCancel: () => {} }),
    )
    expect(lastFrame() ?? '').toContain('无历史会话')
  })
})
