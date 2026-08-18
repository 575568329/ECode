import { describe, it, expect } from 'vitest'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'

const mockTool: Tool = {
  name: 'echo',
  description: 'echo input',
  input_schema: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  readonly: true,
  async execute(args) {
    return { content: (args as { msg: string }).msg }
  },
}

describe('ToolRegistry', () => {
  it('register / get / specs', () => {
    const r = new ToolRegistryImpl()
    r.register(mockTool)
    expect(r.get('echo')?.name).toBe('echo')
    expect(r.get('nope')).toBeUndefined()
    expect(r.specs()).toEqual([
      { name: 'echo', description: 'echo input', input_schema: mockTool.input_schema },
    ])
  })

  it('validate 合法输入 → ok:true', () => {
    const r = new ToolRegistryImpl()
    r.register(mockTool)
    expect(r.validate('echo', { msg: 'hi' })).toEqual({ ok: true })
  })

  it('validate 缺 required → ok:false', () => {
    const r = new ToolRegistryImpl()
    r.register(mockTool)
    const res = r.validate('echo', {})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/msg|required|校验/i)
  })

  it('validate 类型错误 → ok:false', () => {
    const r = new ToolRegistryImpl()
    r.register(mockTool)
    const res = r.validate('echo', { msg: 123 })
    expect(res.ok).toBe(false)
  })

  it('validate 不存在的 tool → ok:false', () => {
    const r = new ToolRegistryImpl()
    const res = r.validate('nope', {})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/不存在/i)
  })
})


describe('M11-P1：list() 全量 Tool 对象', () => {
  it('返回全部注册 Tool（含 readonly 元数据与 execute——specs 重建拿不到的）', () => {
    const reg = new ToolRegistryImpl()
    reg.register({
      name: 't1',
      description: 'd',
      input_schema: { type: 'object', properties: {} },
      readonly: true,
      async execute() {
        return { content: 'ok' }
      },
    })
    reg.register({
      name: 't2',
      description: 'd2',
      input_schema: { type: 'object', properties: {} },
      readonly: false,
      async execute() {
        return { content: 'ok' }
      },
    })
    const all = reg.list()
    expect(all.map((t) => t.name)).toEqual(['t1', 't2'])
    expect(all[0]?.readonly).toBe(true)
    expect(typeof all[0]?.execute).toBe('function')
  })
})
