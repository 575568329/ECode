/**
 * 系统提示（TuiApp REPL + cli argv 单次模式共用）。
 *
 * 含工具职责区分（详设 §2.3 行 231），避免 LLM 在 ls/glob/grep/read_file 间选错。
 * M3 新增 write_file/edit_file 后，职责指引更关键。
 * M6 S-P4：可选注入 skill 清单（<available_skills>，受 token 预算约束）——
 * 调用方传 listForPrompt() 结果与 ctxWindow（TuiApp 缓存值），不传则零 skill 开销。
 */

import type { SkillInfo } from '../services/skill.js'
import { renderSkillListing, listingBudget } from '../services/skill/listing.js'

export function buildSystemPrompt(skills?: SkillInfo[], ctxWindow?: number): string {
  let base = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令、搜索代码，帮用户完成编程任务。
当前工作目录：${process.cwd()}
当前平台：${process.platform}

工具选择指引（选对工具，避免反复试错）：
- ls <path>：列目录内容（文件/子目录 + 元信息），想了解项目结构时用
- glob <pattern>：按 glob 模式匹配找文件路径（如 **/*.ts），知道文件名/扩展名找文件时用
- grep <pattern>：搜文件内容（正则），找某段代码/文本在哪些文件时用
- read_file <path>：读单个文件的完整内容
- write_file <path> <content>：写新文件或覆盖（会请求确认）
- edit_file <path> <oldString> <newString>：改文件中的某段（会请求确认）
- bash <command>：执行 shell 命令

回复用中文。`
  if (skills !== undefined && skills.length > 0) {
    const listing = renderSkillListing(skills, listingBudget(ctxWindow ?? 200_000))
    if (listing !== '') {
      base += '\n\n' + listing
      // 内置手册路由（M6.5，opencode 同式）：用户问 ECode 自身配置时指名加载，防凭记忆猜格式
      // （若用户覆盖的 ecode-config 设了 disable-model-invocation，SkillTool 会拒——不注入路由免误导）
      if (skills.some((s) => s.name === 'ecode-config' && !s.disableModelInvocation)) {
        base += '\n用户询问 ECode 自身的配置或用法（config、MCP、provider、命令等）时，先调用 Skill 工具加载 ecode-config 手册，不要凭记忆猜测配置格式。'
      }
    }
  }
  return base
}
