import { describe, expect, it } from 'vitest'
import { matcherMatches } from '../../../src/services/hooks/matcher.js'

describe('matcherMatches', () => {
  it('matcher 为空匹配全部', () => {
    expect(matcherMatches(undefined, 'bash')).toBe(true)
    expect(matcherMatches('', 'bash')).toBe(true)
    expect(matcherMatches('  ', 'bash')).toBe(true)
  })

  it('精确名匹配', () => {
    expect(matcherMatches('bash', 'bash')).toBe(true)
    expect(matcherMatches('bash', 'edit_file')).toBe(false)
  })

  it('| 列表匹配任一', () => {
    expect(matcherMatches('bash|edit_file|write_file', 'edit_file')).toBe(true)
    expect(matcherMatches('bash|edit_file', 'grep')).toBe(false)
  })

  it('正则匹配（前缀锚定 MCP 工具族）', () => {
    expect(matcherMatches('^mcp__fs', 'mcp__fs__read')).toBe(true)
    expect(matcherMatches('^mcp__fs', 'mcp__db__query')).toBe(false)
  })

  it('非法正则回退字面量（不炸）', () => {
    expect(matcherMatches('edit(file', 'edit(file')).toBe(true)
    expect(matcherMatches('edit(file', 'edit_file')).toBe(false)
  })

  it('matcher 非空而 toolName 为空 → 不匹配（matcher 只对工具事件有意义）', () => {
    expect(matcherMatches('bash', undefined)).toBe(false)
  })
})
