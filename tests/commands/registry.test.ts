import { describe, it, expect, beforeEach } from 'vitest'
import { CommandRegistry, registerBuiltinCommands, commandRegistry } from '../../src/commands/registry.js'

describe('CommandRegistry', () => {
  it('register / get / list', () => {
    const r = new CommandRegistry()
    r.register({ name: 'foo', description: 'd', run: () => ({}) })
    expect(r.get('foo')?.name).toBe('foo')
    expect(r.list()).toHaveLength(1)
  })

  it('get 未注册返回 undefined', () => {
    const r = new CommandRegistry()
    expect(r.get('nope')).toBeUndefined()
  })

  it('match 前缀', () => {
    const r = new CommandRegistry()
    r.register({ name: 'help', description: '', run: () => ({}) })
    r.register({ name: 'history', description: '', run: () => ({}) })
    r.register({ name: 'clear', description: '', run: () => ({}) })
    expect(r.match('he').map((c) => c.name)).toEqual(['help'])
    expect(r.match('h').map((c) => c.name)).toEqual(['help', 'history'])
    expect(r.match('c').map((c) => c.name)).toEqual(['clear'])
  })

  it('match 空前缀返回全部', () => {
    const r = new CommandRegistry()
    r.register({ name: 'a', description: '', run: () => ({}) })
    r.register({ name: 'b', description: '', run: () => ({}) })
    expect(r.match('')).toHaveLength(2)
  })

  it('register 同名覆盖', () => {
    const r = new CommandRegistry()
    r.register({ name: 'x', description: 'old', run: () => ({}) })
    r.register({ name: 'x', description: 'new', run: () => ({}) })
    expect(r.list()).toHaveLength(1)
    expect(r.get('x')?.description).toBe('new')
  })

  it('clear 清空', () => {
    const r = new CommandRegistry()
    r.register({ name: 'x', description: '', run: () => ({}) })
    r.clear()
    expect(r.list()).toHaveLength(0)
  })
})

describe('内置命令', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })

  it('/help 列出命令（含 /help /clear）', () => {
    const r = commandRegistry.get('help')!.run()
    expect(r.output).toContain('/help')
    expect(r.output).toContain('/clear')
    expect(r.output).toContain('/model')
  })

  it('/clear 返回 action=clear', () => {
    expect(commandRegistry.get('clear')!.run().action).toBe('clear')
  })

  it('/expand 返回 action=expand', () => {
    expect(commandRegistry.get('expand')!.run().action).toBe('expand')
  })

  it('/model 返回 action=pick-model', () => {
    expect(commandRegistry.get('model')!.run().action).toBe('pick-model')
  })

  it('match("he") 含 help', () => {
    expect(commandRegistry.match('he').map((c) => c.name)).toContain('help')
  })

  it('registerBuiltinCommands 幂等（重复调用不翻倍）', () => {
    registerBuiltinCommands()
    registerBuiltinCommands()
    expect(commandRegistry.list().filter((c) => c.name === 'help')).toHaveLength(1)
  })
})
