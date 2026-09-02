import { describe, it, expect } from 'vitest'
import {
  inputDigest,
  previewLine,
  summarize,
  groupByName,
  mergeToolGroup,
  FOLD_THRESHOLD,
  MAX_TOOL_VISIBLE,
  type ToolCallEntry,
} from '../../src/tui/toolview.js'
import type { ToolUseBlock, ToolResultBlock } from '../../src/core/types.js'

function use(name: string, input: unknown, id = 't1'): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}
function result(id: string, content: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError }
}

describe('inputDigest', () => {
  it('取 path', () => {
    expect(inputDigest({ path: 'src/foo.ts' })).toBe('src/foo.ts')
  })
  it('取 command（无 path 时）', () => {
    expect(inputDigest({ command: 'npm test' })).toBe('npm test')
  })
  it('无关键字段返回空', () => {
    expect(inputDigest({ foo: 'bar' })).toBe('')
  })
})

describe('previewLine', () => {
  it('取首行', () => {
    expect(previewLine('第一行\n第二行')).toBe('第一行')
  })
  it('截断到 80 字符（缺省下限保底）', () => {
    expect(previewLine('a'.repeat(100))).toHaveLength(80)
  })
  it('动态宽度（2026-09-02 拍板）：maxColumns 跟终端宽走——宽终端多显示、CJK 按显示列计', () => {
    expect(previewLine('a'.repeat(100), 120)).toHaveLength(100) // 宽度内不截
    expect(previewLine('a'.repeat(140), 120)).toHaveLength(120) // 超宽截 119+…
    expect(previewLine('中'.repeat(50), 40)).toHaveLength(20) // 50 CJK=100 列 > 40 → 截 19 字（38 列）+…=20 字符
  })
})

describe('summarize', () => {
  it('running 状态（无 result）', () => {
    const s = summarize({ use: use('read_file', { path: 'a.ts' }) })
    expect(s.status).toBe('running')
    expect(s.bytes).toBe(0)
    expect(s.name).toBe('read_file')
    expect(s.inputDigest).toBe('a.ts')
  })
  it('success 状态（is_error false）', () => {
    const s = summarize({ use: use('read_file', {}), result: result('t1', 'hello') })
    expect(s.status).toBe('success')
    expect(s.bytes).toBe(5)
    expect(s.preview).toBe('hello')
  })
  it('error 状态（is_error true）', () => {
    const s = summarize({ use: use('bash', {}), result: result('t1', '失败', true) })
    expect(s.status).toBe('error')
  })
  it('折叠阈值：> 200 字节 → collapsed=true', () => {
    const s = summarize({ use: use('bash', {}), result: result('t1', 'a'.repeat(201)) })
    expect(s.collapsed).toBe(true)
  })
  it('折叠阈值：<= 200 字节 → collapsed=false', () => {
    const s = summarize({ use: use('bash', {}), result: result('t1', 'a'.repeat(200)) })
    expect(s.collapsed).toBe(false)
  })
})

describe('groupByName', () => {
  it('同工具名聚合，保持首次出现顺序', () => {
    const entries: ToolCallEntry[] = [
      { use: use('read_file', {}, 't1') },
      { use: use('bash', {}, 't2') },
      { use: use('read_file', {}, 't3') },
    ]
    const g = groupByName(entries)
    expect([...g.keys()]).toEqual(['read_file', 'bash'])
    expect(g.get('read_file')).toHaveLength(2)
    expect(g.get('bash')).toHaveLength(1)
  })
  it('空数组', () => {
    expect(groupByName([]).size).toBe(0)
  })
})

describe('FOLD_THRESHOLD', () => {
  it('是 200', () => {
    expect(FOLD_THRESHOLD).toBe(200)
  })
})

describe('MAX_TOOL_VISIBLE', () => {
  it('是 2（折叠态最多展示 2 个工具摘要 + 1 溢出行 = ≤4 行）', () => {
    expect(MAX_TOOL_VISIBLE).toBe(2)
  })
})

describe('mergeToolGroup', () => {
  it('空数组', () => {
    const g = mergeToolGroup([])
    expect(g.count).toBe(0)
    expect(g.visible).toEqual([])
    expect(g.overflow).toBe(0)
  })

  it('N=1：visible 全显，无溢出', () => {
    const tools: ToolCallEntry[] = [{ use: use('bash', {}, 't1') }]
    const g = mergeToolGroup(tools)
    expect(g.count).toBe(1)
    expect(g.visible).toHaveLength(1)
    expect(g.visible[0].use.name).toBe('bash')
    expect(g.overflow).toBe(0)
  })

  it('N=2：visible=2，无溢出', () => {
    const tools: ToolCallEntry[] = [
      { use: use('bash', {}, 't1') },
      { use: use('read_file', {}, 't2') },
    ]
    const g = mergeToolGroup(tools)
    expect(g.count).toBe(2)
    expect(g.visible).toHaveLength(2)
    expect(g.overflow).toBe(0)
  })

  it('N=3：visible=2（前2），overflow=1', () => {
    const tools: ToolCallEntry[] = [
      { use: use('bash', {}, 't1') },
      { use: use('read_file', {}, 't2') },
      { use: use('grep', {}, 't3') },
    ]
    const g = mergeToolGroup(tools)
    expect(g.count).toBe(3)
    expect(g.visible).toHaveLength(2)
    expect(g.visible[0].use.name).toBe('bash')
    expect(g.visible[1].use.name).toBe('read_file')
    expect(g.overflow).toBe(1)
  })

  it('N=10：visible=2，overflow=8（不随 N 增长，恒 ≤4 行）', () => {
    const tools: ToolCallEntry[] = Array.from({ length: 10 }, (_, i) => ({
      use: use(`tool_${i}`, {}, `t${i}`),
    }))
    const g = mergeToolGroup(tools)
    expect(g.count).toBe(10)
    expect(g.visible).toHaveLength(2)
    expect(g.overflow).toBe(8)
  })
})
