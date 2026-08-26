/**
 * 系统提示（TuiApp REPL + cli argv 单次模式共用）。
 *
 * M8 §5 分段化：静态前缀（身份/平台/工具指引——永不变）+ 动态后缀（指令注入/
 * memory 索引/skill 清单/路由行——会话间可变），join 后对外仍是单字符串
 * （Provider 协议不动，调用点零改动）。收益：动态内容变化不击穿前缀的 prompt cache。
 * M8 §1/§3：动态段含两级 ECODE.md/CLAUDE.md 指令与 MEMORY.md 索引注入。
 */

import type { SkillInfo } from '../services/skill.js'
import { renderSkillListing, listingBudget } from '../services/skill/listing.js'
import { ECODE_CONFIG_SKILL_NAME } from '../services/skill/builtin.js'
import { loadInstructions, renderInstructions } from '../services/instructions.js'
import { loadMemoryIndexes, renderMemory } from '../services/memory.js'

/** 动态段注入选项（M8：上限从 config 透传——maxInstructionsKB 可调）。 */
export interface SystemPromptOpts {
  /** 指令/记忆单级上限字节（config maxInstructionsKB × 1024；缺省 32KB） */
  maxInstructionBytes?: number
  /** 会话项目目录（serve 多项目各会话 cwd 不同——曾烤死 process.cwd()，web 加项目后
   *  agent 以为在 serve 启动目录而 bash 实际跑在项目目录，相对路径错位；缺省=单进程形态两者相同） */
  cwd?: string
}

export function buildSystemPrompt(skills?: SkillInfo[], ctxWindow?: number, opts?: SystemPromptOpts): string {
  // —— 静态前缀（永不变，cache 友好）——
  const prefix = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令、搜索代码，帮用户完成编程任务。
当前工作目录：${opts?.cwd ?? process.cwd()}
当前平台：${process.platform}

工具选择指引（选对工具，避免反复试错）：
- ls <path>：列目录内容（文件/子目录 + 元信息），想了解项目结构时用
- glob <pattern>：按 glob 模式匹配找文件路径（如 **/*.ts），知道文件名/扩展名找文件时用
- grep <pattern>：搜文件内容（正则），找某段代码/文本在哪些文件时用
- read_file <path>：读单个文件的完整内容
- write_file <path> <content>：写新文件或覆盖（会请求确认）
- edit_file <path> <oldString> <newString>：改文件中的某段（会请求确认）
- bash <command>：执行 shell 命令
- Skill <skill>：加载工作流手册（available_skills 清单里匹配时调用，返回步骤照做）
- ask_user：需求模糊且调查后仍无法推断时向用户提问（选项框；能推断就别问）
- web_fetch <url>：抓公开网页转文本（查最新文档；优先读本地，线上不确定才用）
- web_search <query>：联网搜索（不知道 URL 时先搜；拿到结果常配合 web_fetch 抓全文；可带 domain/recency 收窄）
- bash run_in_background=true：长命令后台跑（npm test/build/dev server）——立即返回 task_id
- task_output <task_id>：读后台任务增量输出（wait_ms 可短等新输出或退出）
- task_stop <task_id>：终止后台任务（统一杀树，孙进程一并终止）
- task <description> <prompt>：把独立子任务委派给并发子代理（大范围调研/互相独立的并行工作；prompt 必须自包含，阻塞至返回结论）
- todo <todos>：维护多步任务清单（3 步以上才建；全量替换；完成一项立即更新）

回复用中文。`

  // —— 动态后缀（会话间可变；空段过滤——两级都无文件零开销）——
  const dynamic: string[] = []
  const maxBytes = opts?.maxInstructionBytes
  dynamic.push(renderInstructions(loadInstructions(maxBytes !== undefined ? { maxBytes } : {}))) // 指令：用户级先、项目级后
  dynamic.push(renderMemory(loadMemoryIndexes(maxBytes !== undefined ? { maxBytes } : {}))) // 记忆索引
  if (skills !== undefined && skills.length > 0) {
    const listing = renderSkillListing(skills, listingBudget(ctxWindow ?? 200_000))
    if (listing !== '') {
      dynamic.push(listing)
      // 内置手册路由（M6.5，opencode 同式）：用户问 ECode 自身配置时指名加载，防凭记忆猜格式
      // （若用户覆盖的 ecode-config 设了 disable-model-invocation，SkillTool 会拒——不注入路由免误导）
      if (skills.some((s) => s.name === ECODE_CONFIG_SKILL_NAME && !s.disableModelInvocation)) {
        dynamic.push(
          `用户询问 ECode 自身的配置或用法（config、MCP、provider、命令等）时，先调用 Skill 工具加载 ${ECODE_CONFIG_SKILL_NAME} 手册，不要凭记忆猜测配置格式。`,
        )
      }
    }
  }
  return [prefix, ...dynamic.filter((seg) => seg !== '')].join('\n\n')
}
