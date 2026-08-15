import { describe, expect, it, vi } from 'vitest'
import { ExtensionHooksRegistry } from '../../../src/services/hooks/registry.js'
import { HookRunner } from '../../../src/services/hooks/runner.js'
import type { HookExecutor, HookInput, HookOutput, HookSpec } from '../../../src/services/hooks/types.js'

function cmdSpec(event: HookSpec['event'], command: string, matcher?: string): HookSpec {
  return { event, ...(matcher !== undefined ? { matcher } : {}), handler: { kind: 'command', command } }
}

function input(event: HookInput['event'], extra: Partial<HookInput> = {}): HookInput {
  return { event, session_id: 's1', ...extra }
}

function makeRunner(
  execute: HookExecutor,
  opts: { userHooks?: HookSpec[]; extensions?: ExtensionHooksRegistry; warn?: (m: string) => void } = {},
) {
  const ext = opts.extensions ?? new ExtensionHooksRegistry()
  return new HookRunner({
    extensions: ext,
    execute,
    getUserHooks: opts.userHooks !== undefined ? () => opts.userHooks as HookSpec[] : undefined,
    warn: opts.warn,
  })
}

describe('HookRunner.specsFor（双源合并查询）', () => {
  it('用户源 + 扩展源合并，event 过滤', async () => {
    const ext = new ExtensionHooksRegistry()
    ext.register('plugin:x@mkt', [cmdSpec('PreToolUse', 'guard', 'bash')])
    const runner = makeRunner(async () => null, {
      userHooks: [cmdSpec('Stop', 'notify')],
      extensions: ext,
    })
    expect(runner.specsFor('Stop')).toHaveLength(1)
    expect(runner.specsFor('PreToolUse', 'bash')).toHaveLength(1)
    expect(runner.specsFor('PreToolUse', 'grep')).toHaveLength(0)
    expect(runner.hasHandlers('SessionEnd')).toBe(false)
  })
})

describe('HookRunner.dispatch（聚合裁决）', () => {
  it('无匹配 hook → no-op verdict', async () => {
    const runner = makeRunner(async () => { throw new Error('should not run') })
    const v = await runner.dispatch('Stop', input('Stop'))
    expect(v).toEqual({ block: false, additionalContext: [], systemMessages: [] })
  })

  it('continue:false → block + reason；输出协议其余字段聚合', async () => {
    const outputs = new Map<string, HookOutput | null>([
      ['a', { continue: false, reason: '禁用时段' }],
      ['b', { additionalContext: 'ctx-b', systemMessage: 'msg-b' }],
    ])
    const runner = makeRunner(async (spec) => outputs.get(spec.handler.kind === 'command' ? spec.handler.command : '') ?? null, {
      userHooks: [cmdSpec('PreToolUse', 'a'), cmdSpec('PreToolUse', 'b')],
    })
    const v = await runner.dispatch('PreToolUse', input('PreToolUse', { tool_name: 'bash', tool_input: { cmd: 'ls' } }))
    expect(v.block).toBe(true)
    expect(v.reason).toBe('禁用时段')
    expect(v.additionalContext).toEqual(['ctx-b'])
    expect(v.systemMessages).toEqual(['msg-b'])
    expect(v.updatedInput).toBeUndefined()
  })

  it('updatedInput：后者覆盖前者', async () => {
    const runner = makeRunner(
      async (spec) =>
        spec.handler.kind === 'command' && spec.handler.command === 'a'
          ? { updatedInput: { v: 1 } }
          : { updatedInput: { v: 2 } },
      { userHooks: [cmdSpec('PreToolUse', 'a'), cmdSpec('PreToolUse', 'b')] },
    )
    const v = await runner.dispatch('PreToolUse', input('PreToolUse', { tool_name: 'bash', tool_input: { v: 0 } }))
    expect(v.updatedInput).toEqual({ v: 2 })
  })

  it('执行失败 → fail-open（warn + 放行，不影响其余 hook）', async () => {
    const warn = vi.fn()
    const runner = makeRunner(
      async (spec) => {
        if (spec.handler.kind === 'command' && spec.handler.command === 'bad') throw new Error('boom')
        return { systemMessage: 'from-good' }
      },
      { userHooks: [cmdSpec('PreToolUse', 'bad'), cmdSpec('PreToolUse', 'good')], warn },
    )
    const v = await runner.dispatch('PreToolUse', input('PreToolUse', { tool_name: 'bash' }))
    expect(v.block).toBe(false)
    expect(v.systemMessages).toEqual(['from-good'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('boom')
    expect(warn.mock.calls[0]?.[0]).toContain('放行')
  })

  it('async:true 的 hook fire-and-forget：不 await、不参与裁决', async () => {
    const seen: string[] = []
    const runner = makeRunner(async (spec) => {
      const name = spec.handler.kind === 'command' ? spec.handler.command : ''
      seen.push(name)
      return name === 'notify' ? { continue: false } : null
    }, {
      userHooks: [
        { event: 'Stop', handler: { kind: 'command', command: 'notify', async: true } },
        cmdSpec('Stop', 'sync'),
      ],
    })
    const v = await runner.dispatch('Stop', input('Stop'))
    expect(v.block).toBe(false) // async hook 的 continue:false 不进裁决
    // fire-and-forget 已调度（微任务），结果不重要——只验证不阻塞
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toContain('notify')
    expect(seen).toContain('sync')
  })

  it('exit-2 型 block 由执行器翻译（executor 返回 continue:false），runner 只认协议', async () => {
    const runner = makeRunner(async () => ({ continue: false }), { userHooks: [cmdSpec('UserPromptSubmit', 'gate')] })
    const v = await runner.dispatch('UserPromptSubmit', input('UserPromptSubmit', { prompt: 'hi' }))
    expect(v.block).toBe(true)
  })
})
