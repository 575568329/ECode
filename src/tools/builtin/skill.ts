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

  async execute(args) {
    const { skill } = args as { skill: string }
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
    return {
      content: [
        `<skill_content name="${info.name}">`,
        info.body.trim(),
        '',
        `该 Skill 附属文件目录：${info.baseDir}（相对路径基于此目录，需要时用 read_file 读取）。`,
        '</skill_content>',
      ].join('\n'),
    }
  },
}
