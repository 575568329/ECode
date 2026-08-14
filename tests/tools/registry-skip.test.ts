import { describe, it, expect } from 'vitest'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'

const ctx = { cwd: process.cwd(), signal: new AbortController().signal }

function extTool(name: string, schema: object): Tool {
  return {
    name,
    description: '外部工具',
    input_schema: schema,
    readonly: false,
    skipLocalValidate: true,
    execute: async () => ({ content: 'ok' }),
  }
}

describe('ToolRegistry MCP 扩展（M-P1）', () => {
  it('skipLocalValidate：外部 schema（含 $ref/非法结构）不炸注册 + validate 直接 ok', () => {
    const reg = new ToolRegistryImpl()
    // 这种 schema 会让 ajv.compile throw（$ref 指向不存在定义）
    reg.register(extTool('mcp__x__y', { type: 'object', properties: { a: { $ref: '#/$defs/Missing' } } }))
    expect(reg.get('mcp__x__y')).toBeDefined()
    expect(reg.validate('mcp__x__y', { whatever: 1 })).toEqual({ ok: true })
  })

  it('skipLocalValidate=false 仍走 AJV', () => {
    const reg = new ToolRegistryImpl()
    reg.register({
      name: 'normal',
      description: '',
      input_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      readonly: true,
      execute: async () => ({ content: 'ok' }),
    })
    expect(reg.validate('normal', {})).toMatchObject({ ok: false })
    expect(reg.validate('normal', { p: 'x' })).toEqual({ ok: true })
  })

  it('unregister：移除工具与校验器；不存在静默', () => {
    const reg = new ToolRegistryImpl()
    reg.register(extTool('mcp__a__b', { type: 'object' }))
    reg.unregister('mcp__a__b')
    expect(reg.get('mcp__a__b')).toBeUndefined()
    expect(reg.specs().find((s) => s.name === 'mcp__a__b')).toBeUndefined()
    reg.unregister('不存在的') // 不崩
    void ctx
  })
})
