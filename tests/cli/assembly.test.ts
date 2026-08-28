/**
 * M14-C3④⑤ 装配层测试：commandRegistry 注入化（fresh 实例隔离）与 serve 路径资源加载。
 *
 * C3① 拆分后 assembly.ts 可被测试 import（原 cli/index.ts 的 main() 副作用阻断）。
 * 环境隔离：homedir mock 到临时目录——skill/instruction 扫描绝不碰真实 ~/.ecode
 * （重放/验证类测试的既定纪律）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeOs from 'node:os'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>()
  return { ...actual, homedir: () => (globalThis as { __ecodeTestHome?: string }).__ecodeTestHome ?? actual.homedir() }
})

const { makeDeps } = await import('../../src/cli/assembly.js')
const { commandRegistry, CommandRegistry } = await import('../../src/commands/registry.js')
const { emptyShellConfig } = await import('../../src/services/config.js')
import type { Config } from '../../src/services/config.js'

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function testConfig(): Config {
  return {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
}

describe('M14-C3④ commandRegistry 注入化', () => {
  beforeEach(() => {
    ;(globalThis as { __ecodeTestHome?: string }).__ecodeTestHome = mkdtempSync(join(tmpdir(), 'ecode-asm-home-'))
  })
  afterEach(() => {
    const g = globalThis as { __ecodeTestHome?: string }
    if (g.__ecodeTestHome !== undefined) rmSync(g.__ecodeTestHome, { recursive: true, force: true })
    g.__ecodeTestHome = undefined
  })

  it('freshRegistries：commands 为新实例且 builtin 已注册（装配即注册）；两个项目互不共享', () => {
    const cwd = process.cwd()
    const a = makeDeps(testConfig(), noopLogger, 'asm-a', cwd, { freshRegistries: true })
    const b = makeDeps(testConfig(), noopLogger, 'asm-b', cwd, { freshRegistries: true })
    expect(a.commands).toBeInstanceOf(CommandRegistry)
    expect(a.commands).not.toBe(b.commands) // 每项目实例——plugin 命令不跨项目串台
    expect(a.commands).not.toBe(commandRegistry) // 不是模块单例
    expect(a.commands.get('help')).toBeDefined() // builtin 注册随装配（原 main 显式调退役）
    expect(a.commands.list().length).toBe(b.commands.list().length)
    expect(a.skillRegistry).not.toBe(b.skillRegistry) // skills 族同构隔离
  })

  it('缺省（REPL 形态）：commands 即模块单例——InputStream 直读同源兼容', () => {
    const d = makeDeps(testConfig(), noopLogger, 'asm-repl', process.cwd())
    expect(d.commands).toBe(commandRegistry)
  })
})

describe('M14-C3⑤ serve 路径资源加载', () => {
  beforeEach(() => {
    ;(globalThis as { __ecodeTestHome?: string }).__ecodeTestHome = mkdtempSync(join(tmpdir(), 'ecode-asm-home2-'))
  })
  afterEach(() => {
    const g = globalThis as { __ecodeTestHome?: string }
    if (g.__ecodeTestHome !== undefined) rmSync(g.__ecodeTestHome, { recursive: true, force: true })
    g.__ecodeTestHome = undefined
  })

  it('fresh skills.load 后 builtin skill 注入（load 可用性——原 serve 全链未加载，用户技能全失效）', async () => {
    const d = makeDeps(testConfig(), noopLogger, 'asm-load', process.cwd(), { freshRegistries: true })
    // serve 的 createSession 回调同款加载序列（serveMain.ts）
    await d.skillRegistry.load({ builtinCommandNames: d.commands.list().map((c) => c.name) })
    expect(d.skillRegistry.list().length).toBeGreaterThan(0) // builtin skill 随包注入（不读盘）
  })

  it('用户级 skill 目录扫描：homedir mock 隔离下读到假目录的 SKILL.md', async () => {
    const home = (globalThis as { __ecodeTestHome?: string }).__ecodeTestHome
    if (home === undefined) throw new Error('home 未初始化')
    mkdirSync(join(home, '.ecode', 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(
      join(home, '.ecode', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 测试用 skill\n---\n正文\n',
      'utf8',
    )
    const d = makeDeps(testConfig(), noopLogger, 'asm-scan', process.cwd(), { freshRegistries: true })
    await d.skillRegistry.load({ builtinCommandNames: [] })
    expect(d.skillRegistry.get('demo-skill')).toBeDefined() // serve 补加载后用户技能可见
  })

  it('F-28：fresh registry load 后 makeSkillTool(fresh) 能 get 到（旧劈叉形态——静态单例闭包读空报「可用：（无）」）', async () => {
    const { makeSkillTool } = await import('../../src/tools/builtin/skill.js')
    const d = makeDeps(testConfig(), noopLogger, 'asm-f28', process.cwd(), { freshRegistries: true })
    await d.skillRegistry.load({ builtinCommandNames: [] })
    // 全局单例保持空——serve fresh 路径绝不依赖它
    const { skillRegistry: globalReg } = await import('../../src/services/skill.js')
    globalReg.clear()
    const tool = makeSkillTool(d.skillRegistry)
    const r = await tool.execute(
      { skill: d.skillRegistry.list()[0].name },
      { cwd: process.cwd(), signal: new AbortController().signal },
    )
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('<skill_content')
    // 装配进 ToolRegistry 的 Skill 也是注入版：经注册表取到并成功执行（非空单例报错形态）
    const viaReg = d.tools.get('Skill')
    expect(viaReg).toBeDefined()
    const r2 = await viaReg!.execute(
      { skill: d.skillRegistry.list()[0].name },
      { cwd: process.cwd(), signal: new AbortController().signal },
    )
    expect(r2.is_error).toBeFalsy()
  })
})
