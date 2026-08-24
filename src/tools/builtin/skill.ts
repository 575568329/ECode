/**
 * Skill 工具（M6 S-P3）：LLM 面触发入口（Level 1 body 换出）。
 *
 * LLM 按 system prompt 里 <available_skills> 清单的 description 自主决定调用；
 * 返回 body 作为 tool_result（<skill_content> XML）注入一次，零侵入 loop 回喂路径。
 * 双布尔闸门：不存在 → is_error（recoverable 自纠）；disableModelInvocation → is_error
 * （仅手动面可用）。附属文件不预载——LLM 按 body 指引用 read_file 按需读（Level 2）。
 */

import type { Tool } from '../interface.js'
import { skillRegistry } from '../../services/skill.js'
import { globalSkillHooks } from '../../services/hooks/global.js'
import type { ToolContext } from '../interface.js'

export const skillTool: Tool = {
  name: 'Skill',
  description:
    '加载某个 Skill 的完整工作流指令。当任务与 available_skills 清单中某项的描述匹配时调用（即使没被明确点名），传入其 name；返回该 Skill 的完整步骤，按步骤执行。',
  input_schema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill 名（available_skills 清单里的 name）' },
    },
    required: ['skill'],
  },
  readonly: true,

  async execute(args, ctx?: ToolContext) {
    const { skill } = args as { skill: string }
    // M13-B1（#3）：上文已激活（tool_result 含标记）→ 一行 notice 防重复注入全文；
    // 判定在 registry lookup 之前——skill 中途卸载也不影响去重。手动触发面不走 execute（用户主动重读不去重）
    if (ctx?.session?.isSkillActive?.(skill) === true) {
      return { content: `<skill_notice name="${skill}">该 skill 指令已在上文生效，无需重复加载。</skill_notice>` }
    }
    const info = skillRegistry.get(skill)
    if (info === undefined) {
      const names = skillRegistry.listForPrompt().map((s) => s.name)
      return {
        content: `Skill「${skill}」不存在。可用：${names.length > 0 ? names.join(', ') : '（无）'}`,
        is_error: true,
      }
    }
    if (info.disableModelInvocation) {
      return {
        content: `Skill「${skill}」设置了 disable-model-invocation，仅限用户手动 /${skill} 调用`,
        is_error: true,
      }
    }
    const lines = [`<skill_content name="${info.name}">`, info.body.trim()]
    // builtin skill（baseDir=''）无附属文件，不输出目录行
    if (info.baseDir !== '') {
      lines.push('', `该 Skill 附属文件目录：${info.baseDir}（相对路径基于此目录，需要时用 read_file 读取）。`)
    }
    // M7 H-P5：skill 附带 hooks → 会话级注册（skill 使用即启用；/clear 或会话结束注销）
    if (info.hooks !== undefined && info.hooks.length > 0) {
      // M13-W1：经会话端口写项目级 registry（多项目不串台）；无宿主降模块兑底
      const port = ctx?.session?.skillHooks ?? globalSkillHooks
      port.register(info.name, info.hooks)
      const summary = info.hooks.map((h) => `${h.event}${h.matcher !== undefined ? `(${h.matcher})` : ''}`).join('、')
      lines.push('', `该 Skill 已启用 ${info.hooks.length} 个 hooks（本会话）：${summary}`)
    }
    lines.push('</skill_content>')
    return { content: lines.join('\n') }
  },
}
