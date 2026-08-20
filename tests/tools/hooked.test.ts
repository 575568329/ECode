import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import { HookedToolRegistry } from '../../src/tools/hooked.js'
import { HookRunner } from '../../src/services/hooks/runner.js'
import { ExtensionHooksRegistry } from '../../src/services/hooks/registry.js'
import type { HookExecutor, HookSpec } from '../../src/services/hooks/types.js'

beforeEach(() => {
  echoTool.execute.mockClear()
})

const echoTool = {
  name: 'echo_tool',
  description: 'test',
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  execute: vi.fn(async (args: unknown) => ({ content: `done ${JSON.stringify(args)}` })),
}

function makeHookedRegistry(
  hooks: HookSpec[],
  execute: HookExecutor = async () => null,
): { hooked: HookedToolRegistry; runner: HookRunner } {
  const ext = new ExtensionHooksRegistry()
  ext.register('test:owner', hooks)
  const runner = new HookRunner({ extensions: ext, execute })
  const inner = new ToolRegistryImpl()
  inner.register(echoTool)
  let current: HookRunner | null = runner
  return { hooked: new HookedToolRegistry(inner, () => current), runner }
}

describe('HookedToolRegistry（装饰接入，loop 零改动）', () => {
  it('无 runner（getter 返回 null）→ execute 直通原工具', async () => {
    const inner = new ToolRegistryImpl()
    inner.register(echoTool)
    const hooked = new HookedToolRegistry(inner, () => null)
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.content).toBe('done {"a":1}')
  })

  it('无匹配 hook → 直通（零开销路径）', async () => {
    const { hooked } = makeHookedRegistry([{ event: 'Stop', handler: { kind: 'command', command: 'x' } }])
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.content).toBe('done {"a":1}')
  })

  it('PreToolUse block → is_error + reason（不进原工具）', async () => {
    const { hooked } = makeHookedRegistry(
      [{ event: 'PreToolUse', handler: { kind: 'command', command: 'gate' } }],
      async () => ({ continue: false, reason: '禁用时段' }),
    )
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r).toEqual({ content: 'hook blocked：禁用时段', is_error: true })
    expect(echoTool.execute).not.toHaveBeenCalled()
    echoTool.execute.mockClear()
  })

  it('PreToolUse updatedInput → 改参透传原工具', async () => {
    const { hooked } = makeHookedRegistry(
      [{ event: 'PreToolUse', handler: { kind: 'command', command: 'mutate' } }],
      async () => ({ updatedInput: { a: 2 } }),
    )
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.content).toBe('done {"a":2}')
  })

  it('安全审阅 P1：updatedInput 替换后重过校验——非法形态 → is_error 拒绝执行（不进原工具）', async () => {
    // echo_tool 的 schema 无约束（任何对象都过），用带类型约束的工具造失败路径
    const typedTool = {
      name: 'typed_tool',
      description: 'test',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
        additionalProperties: false,
      },
      readonly: true,
      execute: vi.fn(async (args: unknown) => ({ content: `done ${JSON.stringify(args)}` })),
    }
    const ext = new ExtensionHooksRegistry()
    ext.register('test:owner', [{ event: 'PreToolUse', handler: { kind: 'command', command: 'mutate' } }])
    const runner = new HookRunner({ extensions: ext, execute: async () => ({ updatedInput: { a: '不是数字' } }) })
    const inner = new ToolRegistryImpl()
    inner.register(typedTool)
    const hooked = new HookedToolRegistry(inner, () => runner)

    const r = await hooked.get('typed_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.is_error).toBe(true)
    expect(r?.content).toContain('校验失败')
    expect(typedTool.execute).not.toHaveBeenCalled()
  })

  it('PostToolUse additionalContext → 追加到结果（LLM 可见）', async () => {
    const { hooked } = makeHookedRegistry(
      [{ event: 'PostToolUse', handler: { kind: 'command', command: 'fmt' } }],
      async () => ({ additionalContext: 'formatted via prettier' }),
    )
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.content).toContain('done {"a":1}')
    expect(r?.content).toContain('formatted via prettier')
    expect(r?.is_error).toBeUndefined()
  })

  it('matcher 过滤：非匹配工具名不触发 hook', async () => {
    const execute = vi.fn(async () => ({ continue: false }))
    const { hooked } = makeHookedRegistry(
      [{ event: 'PreToolUse', matcher: 'bash', handler: { kind: 'command', command: 'g' } }],
      execute,
    )
    const r = await hooked.get('echo_tool')?.execute({}, { cwd: '.', signal: new AbortController().signal })
    expect(r?.is_error).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it('getter 语义：换 runner 后装饰层用新的（H4 v3.1——不捕获旧实例）', async () => {
    const ext = new ExtensionHooksRegistry()
    const inner = new ToolRegistryImpl()
    inner.register(echoTool)
    let current: HookRunner | null = null
    const hooked = new HookedToolRegistry(inner, () => current)

    // 第一阶段：无 hook
    let r = await hooked.get('echo_tool')?.execute({ v: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.content).toBe('done {"v":1}')

    // 第二阶段：换入带 block hook 的 runner（原子重建后的新实例）
    ext.register('x', [{ event: 'PreToolUse', handler: { kind: 'command', command: 'g' } }])
    current = new HookRunner({ extensions: ext, execute: async () => ({ continue: false, reason: 'v2' }) })
    r = await hooked.get('echo_tool')?.execute({ v: 2 }, { cwd: '.', signal: new AbortController().signal })
    expect(r).toEqual({ content: 'hook blocked：v2', is_error: true })
  })

  it('register/unregister/validate 直通 inner', () => {
    const ext = new ExtensionHooksRegistry()
    const runner = new HookRunner({ extensions: ext, execute: async () => null })
    const inner = new ToolRegistryImpl()
    const hooked = new HookedToolRegistry(inner, () => runner)
    hooked.register(echoTool)
    expect(hooked.get('echo_tool')?.name).toBe('echo_tool')
    expect(hooked.specs().some((s) => s.name === 'echo_tool')).toBe(true)
    expect(hooked.validate('echo_tool', {}).ok).toBe(true)
    hooked.unregister('echo_tool')
    expect(hooked.get('echo_tool')).toBeUndefined()
  })

  it('心脏零改动铁律：loop.ts 无 M7 hooks/plugin 依赖（M5 压缩注释的 hook 字样不算）', () => {
    const loopSrc = readFileSync('src/core/loop.ts', 'utf8')
    expect(loopSrc).not.toMatch(/HookRunner|HookedToolRegistry|ExtensionHooksRegistry|services\/hooks/)
    expect(loopSrc).not.toMatch(/\bplugin/i)
  })

  // —— M9-P0：PreToolUse verdict 全字段消费 + dispatch 透传 AbortSignal ——

  it('PreToolUse block → reason + additionalContext/systemMessages 一并展示（全字段消费）', async () => {
    const { hooked } = makeHookedRegistry(
      [{ event: 'PreToolUse', handler: { kind: 'command', command: 'gate' } }],
      async () => ({
        continue: false,
        reason: '禁用时段',
        additionalContext: '今天是维护日',
        systemMessage: 'check the calendar',
      }),
    )
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.is_error).toBe(true)
    expect(r?.content).toContain('hook blocked：禁用时段')
    expect(r?.content).toContain('今天是维护日')
    expect(r?.content).toContain('[hook] check the calendar')
    expect(echoTool.execute).not.toHaveBeenCalled()
    echoTool.execute.mockClear()
  })

  it('PreToolUse 非阻塞 additionalContext → 注入成功 tool_result（结果前缀）', async () => {
    const { hooked } = makeHookedRegistry(
      [{ event: 'PreToolUse', handler: { kind: 'command', command: 'hint' } }],
      async () => ({ additionalContext: 'target file is read-only fs' }),
    )
    const r = await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: new AbortController().signal })
    expect(r?.is_error).toBeUndefined()
    expect(r?.content).toContain('done {"a":1}')
    expect(r?.content).toContain('target file is read-only fs')
  })

  // —— M9-P5：扩展源 hook 权限门（owner spec 才查；用户源不问） ——

  it('权限 deny → 跳过该 hook（不执行 + warn），其余 hook 继续', async () => {
    const execute = vi.fn(async () => null)
    const ext = new ExtensionHooksRegistry()
    ext.register('skill:bad', [{ event: 'PreToolUse', handler: { kind: 'command', command: 'x' } }])
    ext.register('skill:good', [{ event: 'PreToolUse', handler: { kind: 'command', command: 'y' } }])
    const warn = vi.fn()
    const runner = new HookRunner({
      extensions: ext,
      execute,
      warn,
      checkHookPermission: async (owner) => owner !== 'skill:bad',
    })
    const r = await runner.dispatch('PreToolUse', { event: 'PreToolUse', session_id: '', tool_name: 't', tool_input: {} })
    expect(r.block).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1) // bad 被跳过
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skill:bad'))
  })

  it('用户源 hook（无 owner）不问权限', async () => {
    const execute = vi.fn(async () => null)
    const check = vi.fn(async () => false)
    const ext = new ExtensionHooksRegistry()
    const runner = new HookRunner({
      extensions: ext,
      execute,
      getUserHooks: () => [{ event: 'Stop', handler: { kind: 'command', command: 'u' } }],
      checkHookPermission: check,
    })
    await runner.dispatch('Stop', { event: 'Stop', session_id: '' })
    expect(check).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('checkHookPermission 未装配 → 扩展源直接放行（测试/argv 简化路径）', async () => {
    const execute = vi.fn(async () => null)
    const ext = new ExtensionHooksRegistry()
    ext.register('skill:x', [{ event: 'Stop', handler: { kind: 'command', command: 's' } }])
    const runner = new HookRunner({ extensions: ext, execute })
    await runner.dispatch('Stop', { event: 'Stop', session_id: '' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('Pre/Post dispatch 透传 ctx.signal（hook 子进程随 Ctrl+C 中断）', async () => {
    const execute = vi.fn(async () => null)
    const { hooked } = makeHookedRegistry(
      [
        { event: 'PreToolUse', handler: { kind: 'command', command: 'pre' } },
        { event: 'PostToolUse', handler: { kind: 'command', command: 'post' } },
      ],
      execute,
    )
    const ac = new AbortController()
    await hooked.get('echo_tool')?.execute({ a: 1 }, { cwd: '.', signal: ac.signal })
    expect(execute).toHaveBeenCalledTimes(2)
    for (const call of execute.mock.calls) {
      expect((call[2] as { signal?: AbortSignal } | undefined)?.signal).toBe(ac.signal)
    }
  })
})
