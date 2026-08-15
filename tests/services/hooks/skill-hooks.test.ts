import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillRegistry } from '../../../src/services/skill.js'
import { skillTool } from '../../../src/tools/builtin/skill.js'
import { HookRunner } from '../../../src/services/hooks/runner.js'
import { runCommandHook } from '../../../src/services/hooks/exec.js'
import {
  globalExtensionHooks,
  registerSkillHooks,
  unregisterAllSkillHooks,
  unregisterSkillHooks,
} from '../../../src/services/hooks/global.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp('ecode-skill-hooks-')
  globalExtensionHooks.rebuild([])
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
  globalExtensionHooks.rebuild([])
})

async function mkdtemp(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeSkill(name: string, hooksJson?: string): Promise<string> {
  const dir = path.join(tmpRoot, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test ${name}\n---\n\nbody`, 'utf8')
  if (hooksJson !== undefined) await writeFile(path.join(dir, 'hooks.json'), hooksJson, 'utf8')
  return dir
}

describe('skill hooks.json（H-P5 加载）', () => {
  it('hooks.json 合法 → SkillInfo.hooks', async () => {
    await writeSkill('fmt', JSON.stringify([
      { event: 'PostToolUse', matcher: 'edit_file', handler: { kind: 'command', command: 'prettier .' } },
    ]))
    const reg = new SkillRegistry({ userDir: path.join(tmpRoot, "skills") })
    await reg.load()
    expect(reg.get('fmt')?.hooks).toHaveLength(1)
    expect(reg.loadWarnings).toHaveLength(0)
  })

  it('无 hooks.json → hooks undefined（常态零噪音）', async () => {
    await writeSkill('plain')
    const reg = new SkillRegistry({ userDir: path.join(tmpRoot, "skills") })
    await reg.load()
    expect(reg.get('plain')?.hooks).toBeUndefined()
  })

  it('hooks.json 非法（非数组/坏 event）→ 忽略 + warning，skill 本体不受影响', async () => {
    await writeSkill('bad1', '{"event":"Stop"}') // 对象不是数组
    await writeSkill('bad2', JSON.stringify([{ event: 'NotAnEvent', handler: { kind: 'command', command: 'x' } }]))
    const reg = new SkillRegistry({ userDir: path.join(tmpRoot, "skills") })
    await reg.load()
    expect(reg.get('bad1')?.hooks).toBeUndefined()
    expect(reg.get('bad2')?.hooks).toBeUndefined()
    expect(reg.loadWarnings.length).toBeGreaterThanOrEqual(2)
  })
})

describe('skill hooks 注册桥（全局注册表）', () => {
  it('registerSkillHooks → HookRunner（共享全局注册表）立即可见', () => {
    registerSkillHooks('fmt', [
      { event: 'PostToolUse', matcher: 'edit_file', handler: { kind: 'command', command: 'prettier .' } },
    ])
    const runner = new HookRunner({ extensions: globalExtensionHooks, execute: runCommandHook })
    expect(runner.hasHandlers('PostToolUse')).toBe(true)
    expect(runner.specsFor('PostToolUse', 'edit_file')).toHaveLength(1)
    expect(runner.specsFor('PostToolUse', 'bash')).toHaveLength(0)
  })

  it('unregisterAllSkillHooks 只清 skill: 前缀（plugin 源不动——分层铁律）', () => {
    registerSkillHooks('fmt', [{ event: 'Stop', handler: { kind: 'command', command: 'a' } }])
    globalExtensionHooks.register('plugin:x@mkt', [{ event: 'Stop', handler: { kind: 'command', command: 'b' } }])
    unregisterAllSkillHooks()
    expect(globalExtensionHooks.entries().map((e) => e.owner)).toEqual(['plugin:x@mkt'])
  })

  it('unregisterSkillHooks 单个注销', () => {
    registerSkillHooks('a', [{ event: 'Stop', handler: { kind: 'command', command: 'x' } }])
    registerSkillHooks('b', [{ event: 'Stop', handler: { kind: 'command', command: 'y' } }])
    unregisterSkillHooks('a')
    expect(globalExtensionHooks.entries().map((e) => e.owner)).toEqual(['skill:b'])
  })

  it('registerSkillHooks 空 hooks 不注册', () => {
    registerSkillHooks('empty', [])
    expect(globalExtensionHooks.entries()).toHaveLength(0)
  })
})

describe('SkillTool 与注册桥（LLM 面）', () => {
  it('全局 skillRegistry 为空时 skillTool 返回 is_error（不炸、不注册）', async () => {
    const r = await skillTool.execute({ skill: 'nonexistent' }, { cwd: '.', signal: new AbortController().signal })
    expect(r.is_error).toBe(true)
    expect(globalExtensionHooks.entries()).toHaveLength(0)
  })
})
