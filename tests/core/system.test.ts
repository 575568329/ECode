import { describe, it, expect } from 'vitest'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import { buildSystemPrompt } from '../../src/core/system.js'
import type { SkillInfo } from '../../src/services/skill.js'

function skill(name: string, description: string): SkillInfo {
  return {
    name,
    description,
    body: '',
    baseDir: `/tmp/${name}`,
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
  }
}

describe('buildSystemPrompt（M6 S-P4）', () => {
  it('无 skills → 不出现清单（零开销，向后兼容）', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('ECode')
    expect(p).not.toContain('<available_skills>')
  })

  it('空数组 → 同样不出现清单', () => {
    expect(buildSystemPrompt([], 200_000)).not.toContain('<available_skills>')
  })

  it('W8 cwd 注入：opts.cwd 覆盖 process.cwd()（serve 多项目——曾烤死启动目录，加项目后 agent 报错目录）', () => {
    const p = buildSystemPrompt([], 200_000, { cwd: 'D:/other/proj' })
    expect(p).toContain('当前工作目录：D:/other/proj')
  })

  it('有 skills → 注入 <available_skills>（预算渲染）', () => {
    const p = buildSystemPrompt([skill('commit', '按约定提交')], 200_000)
    expect(p).toContain('<available_skills>')
    expect(p).toContain('<name>commit</name>')
    expect(p.indexOf('<available_skills>')).toBeGreaterThan(0) // 追加在 base 之后
    expect(p).toContain('回复用中文。') // base 部分完整保留
  })

  it('含 ecode-config → 注入内置手册路由行（M6.5）', () => {
    const p = buildSystemPrompt([skill('ecode-config', 'ECode 配置手册')], 200_000)
    expect(p).toContain('先调用 Skill 工具加载 ecode-config 手册')
  })

  it('无 ecode-config → 不注入路由行', () => {
    const p = buildSystemPrompt([skill('commit', '按约定提交')], 200_000)
    expect(p).not.toContain('先调用 Skill 工具加载 ecode-config 手册')
  })
})

describe('活文档防漂移：工具选择指引覆盖全部注册工具（清单 #1）', () => {
  it('每个 builtin 工具都被 system prompt 指引行提及（单一事实源 BUILTIN_TOOLS；词边界匹配防子串误中）', () => {
    const prompt = buildSystemPrompt()
    // 词边界：指引行形如 `- ls <path>：` / `- ask_user：`——名字后必须是非名字字符（防 'ls' 被 'tools' 子串误中）
    const missing = BUILTIN_TOOLS.filter((t) => !new RegExp(`- ${t.name}($|[^a-zA-Z0-9_])`).test(prompt))
    expect(
      missing.map((t) => t.name),
      `system prompt 工具指引缺：${missing.map((t) => t.name).join(', ')}——改 src/core/system.ts 工具选择指引（见 docs/规范/活文档清单 #1）`,
    ).toEqual([])
  })

  it('BUILTIN_TOOLS 名称全局唯一（注册即冲突面）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

// 防漂移方案 §4.4（F3/G3 配套）：ecode-features 手册命令表对账。
// 命令表由 ecodeFeaturesBody() 渲染派生自 commandRegistry（P2-2 拍板），本断言锁的是
// 「渲染管线不断」：若有人退回手工串/组装函数失效（{CMD_TABLE} 占位符漏替换），
// 命令名将从正文消失，此处即红。
describe('活文档防漂移：命令面↔ecode-features 手册对账（清单 §4.4）', () => {
  it('registerBuiltinCommands 后 registry.list() 的每个 name 都出现在手册正文', async () => {
    const { registerBuiltinCommands, commandRegistry } = await import('../../src/commands/registry.js')
    const { builtinSkillInfos, ECODE_FEATURES_SKILL_NAME } = await import('../../src/services/skill/builtin.js')
    registerBuiltinCommands()
    const manual = builtinSkillInfos().find((s) => s.name === ECODE_FEATURES_SKILL_NAME)
    expect(manual, 'ecode-features 内置 skill 应存在').toBeDefined()
    const missing = commandRegistry
      .list()
      .map((c) => `/${c.name}`)
      .filter((name) => !manual!.body.includes(name))
    expect(
      missing,
      `手册缺命令：${missing.join(', ')}——ecodeFeaturesBody() 渲染管线断了（占位符未替换？）`,
    ).toEqual([])
  })

  it('手册已实际组装：占位符 {CMD_TABLE}/{CMD_COUNT} 不残留', async () => {
    const { builtinSkillInfos, ECODE_FEATURES_SKILL_NAME } = await import('../../src/services/skill/builtin.js')
    const body = builtinSkillInfos().find((s) => s.name === ECODE_FEATURES_SKILL_NAME)!.body
    expect(body).not.toContain('{CMD_TABLE}')
    expect(body).not.toContain('{CMD_COUNT}')
    expect(body).toContain('## 快捷键')
    expect(body).toContain('## 多端能力矩阵')
  })

  it('ecode-features 在册时 system prompt 注入功能自述路由行', async () => {
    const { ECODE_FEATURES_SKILL_NAME } = await import('../../src/services/skill/builtin.js')
    const p = buildSystemPrompt([skill(ECODE_FEATURES_SKILL_NAME, 'ECode 功能自述手册')], 200_000)
    expect(p).toContain(`加载 ${ECODE_FEATURES_SKILL_NAME} 手册`)
  })
})
