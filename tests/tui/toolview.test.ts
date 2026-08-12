import { describe, it, expect } from 'vitest'
import {
  inputDigest,
  previewLine,
  summarize,
  groupByName,
  FOLD_THRESHOLD,
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
  it('截断到 80 字符', () => {
    expect(previewLine('a'.repeat(100))).toHaveLength(80)
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
