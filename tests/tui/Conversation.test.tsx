import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { Conversation, GrayStreaming } from '../../src/tui/Conversation.js'
import { createActive, type CommittedItem, type ActiveTool } from '../../src/tui/types.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

describe('GrayStreaming', () => {
  it('灰字显示流式文本', () => {
    const { lastFrame } = render(React.createElement(GrayStreaming, { text: '正在生成回答' }))
    expect(lastFrame()).toContain('正在生成回答')
  })

  it('短文本（≤3 行）不折叠', () => {
    const { lastFrame } = render(React.createElement(GrayStreaming, { text: 'a\nb\nc' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('a')
    expect(f).toContain('c')
    expect(f).not.toContain('折叠')
  })

  it('长文本（>3 行）折叠头部 + 顶部提示', () => {
    const text = '第1行\n第2行\n第3行\n第4行\n第5行\n第6行\n第7行\n第8行'
    const { lastFrame } = render(React.createElement(GrayStreaming, { text }))
    const f = lastFrame() ?? ''
    expect(f).toContain('折叠')
    expect(f).toContain('共 8 行')
    // 尾部 3 行显示
    expect(f).toContain('第6行')
    expect(f).toContain('第8行')
    // 头部 5 行被折叠
    expect(f).not.toContain('第1行')
    expect(f).not.toContain('第5行')
  })
})

function tool(
  opts: { name?: string; id?: string; status?: 'running' | 'done' | 'error'; input?: unknown } = {},
): ActiveTool {
  const id = opts.id ?? 't1'
  const name = opts.name ?? 'bash'
  const use = {
    type: 'tool_use' as const,
    id,
    name,
    input: opts.input ?? { command: 'ls' },
  }
  const status = opts.status ?? 'running'
  if (status === 'running') return { name, use, status }
  return {
    name,
    use,
    status,
    result: {
      type: 'tool_result' as const,
      tool_use_id: id,
      content: 'ok',
      is_error: status === 'error',
    },
  }
}

describe('Conversation', () => {
  it('timeline live text 段 → 灰字（GrayStreaming，活动流 B4）', () => {
    const active = { ...createActive(), timeline: [{ kind: 'text', id: 'x1', text: '流式内容', live: true }], streaming: true }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    expect(lastFrame()).toContain('流式内容')
  })

  it('timeline 终态 text 段（最新）→ Markdown 渲染', () => {
    const active = { ...createActive(), timeline: [{ kind: 'text', id: 'x1', text: '完成的回答', live: false }], streaming: false }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    expect(lastFrame()).toContain('完成的回答')
  })

  it('active 全空 → 动态区无灰字', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, { committed: [], active: createActive() }),
    )
    expect(lastFrame() ?? '').not.toContain('流式')
  })

  it('timeline 工具条目 → 逐行渲染（活动流 B4——合并组退役，预算内全显）', () => {
    const tl = (id: string, name: string) => ({
      kind: 'tool' as const,
      id,
      tool: { name, id, status: 'done' as const },
    })
    const active = {
      ...createActive(),
      timeline: [tl('t1', 'read_file'), tl('t2', 'bash')],
    }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    const f = lastFrame() ?? ''
    expect(f).toContain('read_file')
    expect(f).toContain('bash')
  })

  it('active.userInput → 显示用户消息', () => {
    const active = { ...createActive(), userInput: '帮我写代码' }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    expect(lastFrame()).toContain('帮我写代码')
  })

  it('插话排队留痕（2026-08-29 用户点名）：queuedInterjects 渲染为排队用户行（❯ 图标 + 已排队标记）', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        committed: [],
        active: createActive(),
        queuedInterjects: ['补充一下：用方案 A'],
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('❯')
    expect(f).toContain('补充一下：用方案 A')
    expect(f).toContain('已排队')
  })

  it('排队列表为空时不渲染排队行（Ctrl+U 清空/注入后即消失）', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, { committed: [], active: createActive(), queuedInterjects: [] }),
    )
    expect(lastFrame() ?? '').not.toContain('已排队')
  })

  it('committed 进 Static 渲染（历史消息）', () => {
    const committed: CommittedItem[] = [
      { kind: 'user', id: 'u1', text: '历史用户' },
      { kind: 'assistant-text', id: 'a1', text: '历史回答' },
    ]
    const { lastFrame } = render(
      React.createElement(Conversation, { committed, active: createActive() }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('历史用户')
    expect(f).toContain('历史回答')
  })

  it('children 渲染在动态区', () => {
    const { lastFrame } = render(
      React.createElement(
        Conversation,
        { committed: [], active: createActive() },
        React.createElement(Text, null, '❯ 输入框'),
      ),
    )
    expect(lastFrame()).toContain('❯ 输入框')
  })

  it('组合：历史 + 流式 + 工具 + 输入', () => {
    const committed: CommittedItem[] = [{ kind: 'user', id: 'u1', text: '历史消息' }]
    const active = {
      ...createActive(),
      timeline: [
        { kind: 'tool', id: 't1', tool: { name: 'read_file', id: 't1', status: 'done' } },
        { kind: 'text', id: 'x1', text: '正在流式', live: true },
      ],
    }
    const { lastFrame } = render(
      React.createElement(
        Conversation,
        { committed, active },
        React.createElement(Text, null, '底部输入'),
      ),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('历史消息')
    expect(f).toContain('正在流式')
    // R2 后 24 行窗计价含 margin：live(5+2)+tool(3) 超总盘 9 → 牺牲链保 live 折老 tool（设计行为）
    expect(f).toContain('已折叠')
    expect(f).toContain('底部输入')
  })

  it('userInput 超过 2 行 → 折叠（P1-A）', () => {
    const active = { ...createActive(), userInput: '行1\n行2\n行3\n行4\n行5' }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    const f = lastFrame() ?? ''
    expect(f).toContain('折叠')
    expect(f).toContain('共 5 行')
    expect(f).toContain('行4')
    expect(f).toContain('行5')
    expect(f).not.toContain('行1')
  })

  it('审阅 P1-2：连续审批卡换 requestId → ConfirmPrompt 重挂载（selected 不跨卡泄漏）', () => {
    // F-32 翻案后默认选中 y——泄漏检测改用 n：第一张卡显式选 n，若 selected 泄漏到新卡，
    // 新卡 Enter=拒绝；正确重挂载时新卡按默认 y，Enter=批准。
    const makeConfirm = (id: string) => ({
      use: { type: 'tool_use' as const, id, name: 'bash', input: { command: 'ls' } },
      preview: 'ls',
      resolve: () => {},
    })
    const active = { ...createActive(), confirm: makeConfirm('req-1') }
    const { stdin, lastFrame, rerender } = render(
      React.createElement(Conversation, { committed: [], active }),
    )
    // 第一张卡：←（默认 y 起）← 落到 n（显式选择 n）
    stdin.write('\x1b[D\x1b[D')
    const f1 = lastFrame() ?? ''
    expect(f1).toContain('ls')
    // 第二张卡（不同 requestId）落同一渲染位置——若组件复用，selected 'n' 会带着走
    rerender(
      React.createElement(Conversation, {
        committed: [],
        active: { ...createActive(), confirm: makeConfirm('req-2') },
      }),
    )
    const f2 = lastFrame() ?? ''
    expect(f2).toContain('ls')
    // 通过 Enter 行为验证：新卡空草稿 Enter 按默认 y=批准（F-32）；若 selected 泄漏为 'n' 则拒绝
    let resolved: boolean | null = null
    const confirm2 = makeConfirm('req-2')
    confirm2.resolve = (ok: boolean) => {
      resolved = ok
    }
    rerender(
      React.createElement(Conversation, {
        committed: [],
        active: { ...createActive(), confirm: confirm2 },
      }),
    )
    stdin.write('\r')
    expect(resolved).toBe(true) // 新卡默认 y，Enter=批准（selected 已随 key 重挂载归位）
  })
})

describe('F-36 消息行栅格（第一列只图标，文字含折行续行从第 2 列起）', () => {
  it('assistant 文本：D3 顶格（活动流 2026-09-02 拍板——圆点只标工具行，助手文本空槽）', () => {
    // ink-testing 缺省 80 列：超长中文段落必折行（1 字 2 列）；顶格=首行与续行都在第 2 列起
    const long = '统一栅格验证文本'.repeat(20)
    const { lastFrame } = render(
      React.createElement(Conversation, {
        committed: [{ kind: 'assistant-text', id: 'a1', text: long }],
        active: createActive(),
      }),
    )
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThan(1) // 确已折行
    expect(lines[0].startsWith('● ')).toBe(false) // D3：助手首行不再带圆点
    for (const l of lines) {
      expect(l.startsWith('  ')).toBe(true) // 首行与续行统一第 2 列起（空槽悬挂）
    }
  })

  it('流式灰字同栅格：● 槽 + 灰字折行第 2 列起', () => {
    const long = '流式灰字栅格验证'.repeat(20)
    const { lastFrame } = render(
      React.createElement(Conversation, {
        committed: [],
        active: { ...createActive(), streaming: true, timeline: [{ kind: 'text', id: 'x1', text: long, live: true }] },
      }),
    )
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.trim() !== '' && !l.includes('折叠'))
    expect(lines.length).toBeGreaterThan(1)
    // R4/P1-1：严格断言（旧析取放行了带 ● 的错误形态）——D3 顶格：live 与续行统一第 2 列起
    for (const l of lines) {
      expect(l.startsWith('  ')).toBe(true)
      expect(l.startsWith('● ')).toBe(false)
    }
  })

  it('压缩/回退标记：空槽对齐第 2 列（无符号占位）', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        committed: [
          { kind: 'compacted', id: 'c1', removedCount: 3 },
          { kind: 'rewind', id: 'r1', seq: 7 },
        ],
        active: createActive(),
      }),
    )
    for (const l of (lastFrame() ?? '').split('\n')) {
      if (l.includes('已压缩') || l.includes('已回退')) expect(l.startsWith('  ')).toBe(true)
    }
  })
})
