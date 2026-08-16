/**
 * builtin 工具注册集（单一事实源，审阅 P1-7）：
 * cli makeDeps 从这里注册；防漂移测试从这里断言 system prompt 指引覆盖——
 * 新工具加进本数组即被双端消费，不存在"注册了但测试忘了登记"的缝隙。
 */

import type { Tool } from '../interface.js'
import { readFileTool } from './read_file.js'
import { bashTool } from './bash.js'
import { lsTool } from './ls.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { writeFileTool } from './write_file.js'
import { editFileTool } from './edit_file.js'
import { skillTool } from './skill.js'
import { askUserTool } from './ask_user.js'
import { webFetchTool } from './web_fetch.js'

export const BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  bashTool,
  lsTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  skillTool,
  askUserTool,
  webFetchTool,
]
