/**
 * 任务清单常驻面板测试（2026-08-30 对标改造）：todo 清单从对话流工具行移至输入区上方
 * 常驻面板（CC/harness/opencode 三家共识「清单不进 transcript」），默认展开最新整表。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup } from 'ink-testing-library'
import { render } from 'ink-testing-library'
import { deriveLatestTodos, TodoPanel, type TodoEntry } from '../../src/tui/TodoPanel.js'

const todos: TodoEntry[] = [
  { content: '读配置文件', status: 'completed' },
  { content: '改模板字段', status: 'in_progress' },
  { content: '跑测试', status: 'pending' },
]

// 审阅 P2：ink-testing instances 只增不减——全库 afterEach(cleanup) 铁律最后一处漏网
describe('TodoPanel 渲染', () => {
  afterEach(() => cleanup())

  it('有清单 → 头部完成度 + 逐项状态符（✓/▸/○）', () => {
    const { lastFrame } = render(<TodoPanel todos={todos} />)
    const f = lastFrame() ?? ''
    expect(f).toContain('任务清单')
    expect(f).toContain('1/3 完成')
    expect(f).toContain('✓ 读配置文件')
    expect(f).toContain('▸ 改模板字段')
    expect(f).toContain('○ 跑测试')
  })

  it('null/空清单/altMode → 不渲染（零占行）', () => {
    expect(render(<TodoPanel todos={null} />).lastFrame()).toBe('')
    expect(render(<TodoPanel todos={[]} />).lastFrame()).toBe('')
    expect(render(<TodoPanel todos={todos} altMode />).lastFrame()).toBe('')
  })

  it('超过 12 项截断 + 摘要行（常驻面板不能无限占行——CC TaskListV2 同款思路）', () => {
    const many: TodoEntry[] = Array.from({ length: 15 }, (_, i) => ({ content: `任务${i}`, status: 'pending' }))
    const f = render(<TodoPanel todos={many} />).lastFrame() ?? ''
    expect(f).toContain('任务0')
    expect(f).toContain('任务11')
    expect(f).not.toContain('任务12 ')
    expect(f).toContain('…还有 3 项')
  })
})

describe('deriveLatestTodos 派生', () => {
  const todoUse = { input: { todos } }

  it('active 压轴优先（倒序取最新——运行中的最新替换胜过历史 committed）', () => {
    const committedCall = { name: 'todo', use: { input: { todos: [{ content: '旧', status: 'completed' }] } } }
    const activeCall = { name: 'todo', use: todoUse }
    expect(deriveLatestTodos([committedCall, activeCall])).toEqual(todos)
  })

  it('committed 倒序取最近一次 todo 调用；非 todo 工具跳过', () => {
    const calls = [
      { name: 'bash', use: { input: { command: 'ls' } } },
      { name: 'todo', use: todoUse },
      { name: 'read_file', use: { input: { path: 'x' } } },
    ]
    expect(deriveLatestTodos(calls)).toEqual(todos)
  })

  it('无 todo 调用 → null（面板零占行）', () => {
    expect(deriveLatestTodos([{ name: 'bash', use: { input: {} } }])).toBeNull()
    expect(deriveLatestTodos([])).toBeNull()
  })

  it('全部完成 → 面板自动收起（null）', () => {
    const allDone = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ]
    const { lastFrame } = render(<TodoPanel todos={allDone} />)
    // ink-testing 的 lastFrame() 对 null 渲染返回上一帧残留字符串——断言「不含面板标题」即收起
    expect(lastFrame() ?? '').not.toContain('任务清单')
  })
})
