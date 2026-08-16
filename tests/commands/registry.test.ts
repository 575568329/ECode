import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { existsSync } from 'node:fs'
import { CommandRegistry, registerBuiltinCommands, commandRegistry, buildDoctorPrompt } from '../../src/commands/registry.js'

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
    expect(r.output).toContain('/history')
    expect(r.output).toContain('/setup')
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

  it('/history 返回 action=pick-history', () => {
    expect(commandRegistry.get('history')!.run().action).toBe('pick-history')
  })

  it('/setup 返回 action=start-setup', () => {
    expect(commandRegistry.get('setup')!.run().action).toBe('start-setup')
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

describe('/config 平台判断', () => {
  const origPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('win32 注册 /config（explorer）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const r = new CommandRegistry()
    registerBuiltinCommands(r)
    expect(r.get('config')).toBeDefined()
  })

  it('darwin 注册 /config（open）', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const r = new CommandRegistry()
    registerBuiltinCommands(r)
    expect(r.get('config')).toBeDefined()
  })

  it('linux 不注册 /config（无可靠 opener，用 /setup）', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const r = new CommandRegistry()
    registerBuiltinCommands(r)
    expect(r.get('config')).toBeUndefined()
  })
})

describe('M6 命令（/skill /skill-create /mcp）', () => {
  beforeEach(() => {
    commandRegistry.clear()
    registerBuiltinCommands()
  })

  it('/mcp 无参 → open-mcp-panel', () => {
    expect(commandRegistry.get('mcp')!.run()).toEqual({ action: 'open-mcp-panel' })
  })

  it('/mcp reconnect → mcp-reconnect；带 server 名 → payload', () => {
    expect(commandRegistry.get('mcp')!.run('reconnect')).toEqual({ action: 'mcp-reconnect' })
    expect(commandRegistry.get('mcp')!.run('reconnect db')).toEqual({ action: 'mcp-reconnect', payload: 'db' })
  })

  it('/skill 与 /skill-create 注册', () => {
    expect(commandRegistry.get('skill')!.run()).toEqual({ action: 'skill-panel' })
    expect(commandRegistry.get('skill-create')!.run()).toEqual({ action: 'skill-create' })
  })
})

describe('buildDoctorPrompt（审阅 P1-4 运行时构造）', () => {
  it('路径按本机 homedir 展开（read_file 可直接读）', () => {
    const prompt = buildDoctorPrompt()
    expect(prompt).not.toContain('~/.ecode')
    expect(prompt).toContain(homedir().split(sep).join('/'))
    expect(prompt).toContain('/.ecode/config.json')
  })

  it('ECode 开发仓库内含第 7 项（活文档抽查），普通路径args透传', () => {
    // 本测试进程 cwd=ECode 仓库 → 第 7 项应在
    const prompt = buildDoctorPrompt()
    const hasItem7 = prompt.includes('活文档抽查')
    expect(hasItem7).toBe(existsSync('src/core/system.ts'))
    // args 透传附加关注
    expect(buildDoctorPrompt('重点看 hooks')).toContain('重点看 hooks')
  })
})
