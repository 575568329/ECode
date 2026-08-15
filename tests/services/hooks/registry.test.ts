import { describe, expect, it } from 'vitest'
import { ExtensionHooksRegistry } from '../../../src/services/hooks/registry.js'
import type { HookSpec } from '../../../src/services/hooks/types.js'

function cmd(event: HookSpec['event'], command = 'echo hi', matcher?: string): HookSpec {
  return { event, ...(matcher !== undefined ? { matcher } : {}), handler: { kind: 'command', command } }
}

describe('ExtensionHooksRegistry', () => {
  it('register + specs 展平 + unregister 移除', () => {
    const reg = new ExtensionHooksRegistry()
    reg.register('skill:a', [cmd('Stop'), cmd('PostToolUse', 'fmt')])
    reg.register('plugin:x@mkt', [cmd('PreToolUse', 'guard')])
    expect(reg.specs()).toHaveLength(3)

    reg.unregister('skill:a')
    expect(reg.specs()).toHaveLength(1)
    expect(reg.specs()[0]?.handler).toEqual({ kind: 'command', command: 'guard' })
  })

  it('register 空 hooks 等价注销', () => {
    const reg = new ExtensionHooksRegistry()
    reg.register('skill:a', [cmd('Stop')])
    reg.register('skill:a', [])
    expect(reg.specs()).toHaveLength(0)
  })

  it('rebuild 原子替换：旧 owner 全清，不残留', () => {
    const reg = new ExtensionHooksRegistry()
    reg.register('skill:old', [cmd('Stop')])
    reg.rebuild([
      { owner: 'plugin:new@mkt', hooks: [cmd('SessionStart')] },
      { owner: 'skill:keep', hooks: [cmd('Stop', 's2')] },
    ])
    expect(reg.entries().map((e) => e.owner).sort()).toEqual(['plugin:new@mkt', 'skill:keep'])
    expect(reg.specs().some((s) => s.handler.kind === 'command' && s.handler.command === 'echo hi' && s.event === 'Stop' && s.matcher === undefined)).toBe(false)
  })

  it('register 覆盖同 owner（后写胜）', () => {
    const reg = new ExtensionHooksRegistry()
    reg.register('skill:a', [cmd('Stop', 'v1')])
    reg.register('skill:a', [cmd('Stop', 'v2')])
    expect(reg.specs()).toHaveLength(1)
    expect(reg.specs()[0]?.handler).toEqual({ kind: 'command', command: 'v2' })
  })
})
