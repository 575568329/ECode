import { describe, expect, it } from 'vitest'
import { parseUserHooks } from '../../../src/services/hooks/validate.js'

describe('parseUserHooks（用户源 config hooks 键）', () => {
  it('undefined/null/非数组 → 空 hooks（非数组给 warning）', () => {
    expect(parseUserHooks(undefined)).toEqual({ hooks: [], warnings: [] })
    expect(parseUserHooks(null)).toEqual({ hooks: [], warnings: [] })
    const bad = parseUserHooks({ a: 1 })
    expect(bad.hooks).toHaveLength(0)
    expect(bad.warnings).toHaveLength(1)
  })

  it('合法 command hook 通过', () => {
    const { hooks, warnings } = parseUserHooks([
      { event: 'PostToolUse', matcher: 'edit_file|write_file', handler: { kind: 'command', command: 'prettier .', timeout_ms: 5000 } },
    ])
    expect(warnings).toHaveLength(0)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.event).toBe('PostToolUse')
    expect(hooks[0]?.handler).toEqual({ kind: 'command', command: 'prettier .', timeout_ms: 5000 })
  })

  it('非法 event / 缺 handler / 缺 command → 跳过 + warn', () => {
    const { hooks, warnings } = parseUserHooks([
      { event: 'NotAnEvent', handler: { kind: 'command', command: 'x' } },
      { event: 'Stop' },
      { event: 'Stop', handler: { kind: 'command', command: '' } },
      'not-an-object',
      { event: 'Stop', handler: { kind: 'command', command: 'ok' } },
    ])
    expect(hooks).toHaveLength(1)
    expect(warnings).toHaveLength(4)
  })

  it('后置形态（mcp_tool/prompt）→ 跳过并提示未实现', () => {
    const { hooks, warnings } = parseUserHooks([
      { event: 'PreToolUse', handler: { kind: 'mcp_tool', server: 'fs', tool: 'read', input: {} } },
    ])
    expect(hooks).toHaveLength(0)
    expect(warnings[0] ?? '').toContain('未实现')
  })
})
