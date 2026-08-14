import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  SkillRegistry,
  parseSkillMd,
  serializeSkillMd,
  splitSections,
  mergeBody,
  findProjectSkillsDir,
} from '../../src/services/skill.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-skill-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
});

function makeRegistry(): { reg: SkillRegistry; userDir: string; projectDir: string } {
  const userDir = path.join(tmpRoot, 'user', 'skills')
  const projectDir = path.join(tmpRoot, 'proj', '.ecode', 'skills')
  return { reg: new SkillRegistry({ userDir, projectDir }), userDir, projectDir }
}

function writeSkill(dir: string, name: string, md: string): void {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), md, 'utf8')
}

const VALID = (name: string, desc = '测试技能描述') => `---
name: ${name}
description: ${desc}
---

# ${name}

## 步骤

1. 做事
`

describe('parseSkillMd', () => {
  it('标准 frontmatter + body', () => {
    const { fm, body } = parseSkillMd('---\nname: a\ndescription: d\n---\n\nbody')
    expect(fm['name']).toBe('a')
    expect(fm['description']).toBe('d')
    expect(body).toBe('body')
  })

  it('无 frontmatter → 空对象 + 全文 body', () => {
    const { fm, body } = parseSkillMd('just text')
    expect(fm).toEqual({})
    expect(body).toBe('just text')
  })

  it('带引号值/布尔值/未知字段', () => {
    const { fm } = parseSkillMd('---\nname: a\ndescription: "有: 冒号"\nflag: true\nwhen_to_use: 用时\n---\n')
    expect(fm['description']).toBe('有: 冒号')
    expect(fm['flag']).toBe('true')
    expect(fm['when_to_use']).toBe('用时')
  })

  it('CRLF 换行', () => {
    const { fm, body } = parseSkillMd('---\r\nname: a\r\ndescription: d\r\n---\r\n\r\nbody')
    expect(fm['name']).toBe('a')
    expect(body).toBe('body')
  })
})

describe('serializeSkillMd round-trip', () => {
  it('默认布尔不写出，非默认写出', () => {
    const text = serializeSkillMd({
      name: 'commit',
      description: '按约定提交',
      body: '# commit\n',
      whenToUse: '用户要求 git 提交时',
    })
    expect(text).toContain('when_to_use: 用户要求 git 提交时')
    expect(text).not.toContain('user-invocable')
    expect(text).not.toContain('disable-model-invocation')
    const { fm } = parseSkillMd(text)
    expect(fm['name']).toBe('commit')

    const text2 = serializeSkillMd({
      name: 'x',
      description: 'd',
      body: 'b',
      userInvocable: false,
      disableModelInvocation: true,
    })
    expect(text2).toContain('user-invocable: false')
    expect(text2).toContain('disable-model-invocation: true')
  })

  it('description 含换行/冒号 → 折叠且可 round-trip', () => {
    const text = serializeSkillMd({ name: 'a', description: '第一行: 第二行\n第三行', body: 'b' })
    const { fm } = parseSkillMd(text)
    expect(fm['description']).toBe('第一行: 第二行 第三行')
  })
})

describe('splitSections / mergeBody', () => {
  const existing = `# 标题

引言段。

## 安装

装东西

## 步骤

1. 一步
`

  it('切分 preamble 与 sections', () => {
    const s = splitSections(existing)
    expect(s.preamble).toContain('# 标题')
    expect(s.sections.map((x) => x.title)).toEqual(['安装', '步骤'])
    expect(s.sections[0].text).toContain('## 安装')
  })

  it('同名替换 + 新增追加', () => {
    const patch = `## 步骤

1. 新步骤

## 备注

新增段
`
    const merged = mergeBody(existing, patch)
    const s = splitSections(merged)
    expect(s.sections.map((x) => x.title)).toEqual(['安装', '步骤', '备注'])
    expect(s.sections[1].text).toContain('新步骤')
    expect(s.sections[1].text).not.toContain('一步')
  })

  it('keep 裁决 → 丢弃补丁段（保留现有/不引入新段）', () => {
    const patch = '## 步骤\n\n1. 新步骤\n\n## 备注\n\n新增段\n'
    const merged = mergeBody(existing, patch, [{ title: '步骤', verdict: 'keep' }, { title: '备注', verdict: 'keep' }])
    expect(merged).toContain('1. 一步')
    expect(merged).not.toContain('新步骤')
    expect(merged).not.toContain('备注')
  })

  it('补丁 preamble 非空 → 覆盖 preamble；空 → 保留旧的', () => {
    const withPreamble = mergeBody(existing, '# 新标题\n\n## 步骤\n\nx\n')
    expect(splitSections(withPreamble).preamble).toContain('# 新标题')
    const noPreamble = mergeBody(existing, '## 安装\n\ny\n')
    expect(splitSections(noPreamble).preamble).toContain('# 标题')
  })
})

describe('SkillRegistry.load', () => {
  it('发现 user 级 skill；name/description 回退', async () => {
    const { reg, userDir } = makeRegistry()
    writeSkill(userDir, 'commit', VALID('commit'))
    // 无 name → 回退目录名；无 description → 回退 body 首段
    writeSkill(userDir, 'fallback', '---\n---\n\n第一段当描述\n\n正文')
    await reg.load()
    expect(reg.get('commit')).toBeDefined()
    const fb = reg.get('fallback')
    expect(fb?.name).toBe('fallback')
    expect(fb?.description).toBe('第一段当描述')
    expect(fb?.userInvocable).toBe(true)
    expect(fb?.disableModelInvocation).toBe(false)
  })

  it('目录不存在 → 静默空清单', async () => {
    const { reg } = makeRegistry()
    await reg.load()
    expect(reg.list()).toHaveLength(0)
  })

  it('项目级同名覆盖用户级（首个胜出 + warn）', async () => {
    const { reg, userDir, projectDir } = makeRegistry()
    writeSkill(projectDir, 'commit', VALID('commit', '项目版'))
    writeSkill(userDir, 'commit', VALID('commit', '用户版'))
    await reg.load()
    expect(reg.get('commit')?.description).toBe('项目版')
    expect(reg.get('commit')?.source).toBe('project')
    expect(reg.loadWarnings.some((w) => w.includes('遮蔽'))).toBe(true)
  })

  it('frontmatter 非法（name 不合规/description 空）→ 跳过 + warn', async () => {
    const { reg, userDir } = makeRegistry()
    writeSkill(userDir, 'bad', '---\nname: Bad_Name!\ndescription: d\n---\nbody')
    writeSkill(userDir, 'nodesc', '---\nname: nodesc\n---\n\n\n')
    await reg.load()
    expect(reg.get('bad')).toBeUndefined()
    expect(reg.get('nodesc')).toBeUndefined()
    expect(reg.loadWarnings.length).toBeGreaterThanOrEqual(2)
  })

  it('双布尔过滤：listForPrompt / listForCompletion', async () => {
    const { reg, userDir } = makeRegistry()
    writeSkill(userDir, 'normal', VALID('normal'))
    writeSkill(userDir, 'manualonly', '---\nname: manualonly\ndescription: d\ndisable-model-invocation: true\n---\nb')
    writeSkill(userDir, 'llmonly', '---\nname: llmonly\ndescription: d\nuser-invocable: false\n---\nb')
    await reg.load()
    expect(reg.listForPrompt().map((s) => s.name).sort()).toEqual(['llmonly', 'normal'])
    expect(reg.listForCompletion().map((s) => s.name).sort()).toEqual(['manualonly', 'normal'])
    expect(reg.list()).toHaveLength(3)
  })

  it('与内置命令撞名 → shadowedByCommand 标记', async () => {
    const { reg, userDir } = makeRegistry()
    writeSkill(userDir, 'help', VALID('help'))
    await reg.load({ builtinCommandNames: ['help', 'model'] })
    expect(reg.shadowedByCommand.has('help')).toBe(true)
    expect(reg.loadWarnings.some((w) => w.includes('help'))).toBe(true)
  })

  it('addSource 追加 plugin 级（最低优先级）', async () => {
    const { reg, userDir } = makeRegistry()
    writeSkill(userDir, 'a', VALID('a'))
    const pluginDir = path.join(tmpRoot, 'plugin-skills')
    writeSkill(pluginDir, 'b', VALID('b'))
    writeSkill(pluginDir, 'a', VALID('a', 'plugin 版'))
    await reg.load()
    await reg.addSource(pluginDir)
    expect(reg.get('a')?.description).toBe('测试技能描述') // user 级先注册，plugin 不覆盖
    const b = reg.get('b')
    expect(b?.source).toBe('plugin')
  })

  it('clear 清空', async () => {
    const { reg, userDir } = makeRegistry()
    writeSkill(userDir, 'a', VALID('a'))
    await reg.load()
    reg.clear()
    expect(reg.list()).toHaveLength(0)
  })
})

describe('SkillRegistry.install', () => {
  it('创建模式：落盘 + 注册 + 可解析回来', async () => {
    const { reg, userDir } = makeRegistry()
    const result = await reg.install({ name: 'commit', description: '按约定提交', body: '# commit\n\n## 步骤\n\n1. x\n' })
    expect(result.mode).toBe('created')
    expect(fs.existsSync(path.join(userDir, 'commit', 'SKILL.md'))).toBe(true)
    const info = reg.get('commit')
    expect(info?.description).toBe('按约定提交')
  })

  it('非法 name / 空 description → throw', async () => {
    const { reg } = makeRegistry()
    await expect(reg.install({ name: 'Bad!', description: 'd', body: 'b' })).rejects.toThrow('skill 名非法')
    await expect(reg.install({ name: 'ok', description: '  ', body: 'b' })).rejects.toThrow('description')
  })

  it('升级模式：versions 备份 + frontmatter 整体采用新值 + section 合并', async () => {
    const { reg } = makeRegistry()
    await reg.install({ name: 'doc', description: '旧描述', whenToUse: '旧时机', body: '# doc\n\n## 步骤\n\n1. 旧\n' })
    const result = await reg.install({
      name: 'doc',
      description: '新描述',
      body: '## 步骤\n\n1. 新\n\n## 备注\n\n加的\n',
    })
    expect(result.mode).toBe('upgraded')
    if (result.mode === 'upgraded') {
      expect(fs.existsSync(path.join(result.backedUpTo, 'SKILL.md'))).toBe(true)
      expect(result.conflicts).toEqual(['步骤'])
    }
    const info = reg.get('doc')
    expect(info?.description).toBe('新描述') // frontmatter 整体新值
    expect(info?.whenToUse).toBeUndefined() // 旧 when_to_use 不保留
    expect(info?.body).toContain('1. 新')
    expect(info?.body).toContain('## 备注')
    expect(info?.body).not.toContain('1. 旧')
  })

  it('keep 裁决 → 保留现有 section', async () => {
    const { reg } = makeRegistry()
    await reg.install({ name: 'doc', description: 'd', body: '## 步骤\n\n1. 旧\n' })
    const result = await reg.install(
      { name: 'doc', description: 'd', body: '## 步骤\n\n1. 新\n' },
      [{ title: '步骤', verdict: 'keep' }],
    )
    expect(result.mode).toBe('upgraded')
    if (result.mode === 'upgraded') expect(result.conflicts).toEqual([])
    expect(reg.get('doc')?.body).toContain('1. 旧')
  })

  it('versions 上限 10（第 11 次备份挤掉 v1）', async () => {
    const { reg } = makeRegistry()
    // 12 次 install = 1 次创建 + 11 次升级备份（v1..v11，v1 被淘汰）
    for (let i = 0; i <= 11; i++) {
      await reg.install({ name: 'doc', description: `d${i}`, body: `## S\n\nv${i}\n` })
    }
    const versionsDir = path.join(tmpRoot, 'user', 'skills', 'doc', 'versions')
    const dirs = fs.readdirSync(versionsDir)
    expect(dirs).toHaveLength(10)
    expect(dirs).not.toContain('v1') // v1 被淘汰
    expect(dirs).toContain('v11')
  })
})

describe('findProjectSkillsDir', () => {
  it('向上找到最近的 .ecode/skills；到 home 停', () => {
    const proj = path.join(tmpRoot, 'walk-proj')
    const skills = path.join(proj, '.ecode', 'skills')
    fs.mkdirSync(skills, { recursive: true })
    const deep = path.join(proj, 'a', 'b')
    fs.mkdirSync(deep, { recursive: true })
    expect(findProjectSkillsDir(deep)).toBe(path.resolve(skills))
    expect(findProjectSkillsDir(tmpRoot)).toBeUndefined()
  })
})
