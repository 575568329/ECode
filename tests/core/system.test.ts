import { describe, it, expect } from 'vitest'
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
  // builtin 工具全集（加新工具时在此登记——忘了登记，指引漂移测试也抓不到你，但 /doctor 会）
  const builtinTools = ['ls', 'glob', 'grep', 'read_file', 'write_file', 'edit_file', 'bash', 'Skill', 'ask_user', 'web_fetch']

  it('每个 builtin 工具名都被 system prompt 提及（新工具注册但指引没写 → 此处红）', () => {
    const prompt = buildSystemPrompt()
    const missing = builtinTools.filter((t) => !prompt.includes(t))
    expect(missing, `system prompt 工具指引缺：${missing.join(', ')}——改 src/core/system.ts 工具选择指引（见 docs/规范/活文档清单 #1）`).toEqual([])
  })
})
