import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../../../src/tools/interface.js'
import { skillTool } from '../../../src/tools/builtin/skill.js'
import { skillRegistry, expandSkill, type SkillInfo } from '../../../src/services/skill.js'

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

beforeEach(() => {
  skillRegistry.clear()
})

function reg(info: Partial<SkillInfo> & { name: string }): void {
  // 直接往单例塞测试数据（clear 在 beforeEach；get/list 走公开接口）
  ;(skillRegistry as unknown as { skills: Map<string, SkillInfo> }).skills.set(info.name, {
    description: 'd',
    body: `# ${info.name}\n\n步骤…`,
    baseDir: `/tmp/${info.name}`,
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
    ...info,
  } as SkillInfo)
}

describe('skillTool', () => {
  it('存在 → <skill_content> 含 body 与 baseDir', async () => {
    reg({ name: 'commit', body: '# commit\n\n1. 跑测试' })
    const r = await skillTool.execute({ skill: 'commit' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('<skill_content name="commit">')
    expect(r.content).toContain('1. 跑测试')
    expect(r.content).toContain('/tmp/commit')
  })

  it('不存在 → is_error + 可用列表', async () => {
    reg({ name: 'a' })
    const r = await skillTool.execute({ skill: 'nope' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('不存在')
    expect(r.content).toContain('a')
  })

  it('disableModelInvocation → is_error 提示手动路径', async () => {
    reg({ name: 'manual', disableModelInvocation: true })
    const r = await skillTool.execute({ skill: 'manual' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('/manual')
  })

  it('readonly=true（免确认可并行）', () => {
    expect(skillTool.readonly).toBe(true)
  })
})

describe('expandSkill', () => {
  const info = (body: string): SkillInfo => ({
    name: 'commit',
    description: 'd',
    body,
    baseDir: '/tmp/commit',
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
  })

  it('$ARGUMENTS 占位符 → 替换', () => {
    const out = expandSkill(info('主题：$ARGUMENTS\n步骤'), '修复登录')
    expect(out).toContain('主题：修复登录')
    expect(out).not.toContain('$ARGUMENTS')
    expect(out).toContain('<skill_content name="commit">')
    expect(out).toContain('/tmp/commit')
  })

  it('无占位符 → 兜底追加 ARGUMENTS:', () => {
    const out = expandSkill(info('步骤一'), '修复登录')
    expect(out).toContain('ARGUMENTS: 修复登录')
  })

  it('未传参 → 剥掉残留占位符', () => {
    const out = expandSkill(info('主题：$ARGUMENTS'), undefined)
    expect(out).not.toContain('$ARGUMENTS')
    expect(out).not.toContain('ARGUMENTS:')
  })

  it('空串参数视同未传', () => {
    const out = expandSkill(info('主题：$ARGUMENTS'), '  ')
    expect(out).not.toContain('$ARGUMENTS')
  })
})

describe('builtin skill（baseDir 空）', () => {
  it('builtin（baseDir=""）→ 不输出附属文件目录行', async () => {
    reg({ name: 'ecode-config', baseDir: '', source: 'builtin' })
    const r = await skillTool.execute({ skill: 'ecode-config' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('<skill_content name="ecode-config">')
    expect(r.content).not.toContain('附属文件目录')
  })
})
