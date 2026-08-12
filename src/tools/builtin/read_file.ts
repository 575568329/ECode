/**
 * read_file 工具（只读）：读取文本文件内容。
 *
 * readonly:true（免确认、可并行）。M1 最小版：UTF-8 读取，相对 cwd 或绝对路径。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Tool } from '../interface.js'

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文本文件内容（UTF-8）。path 可相对当前工作目录或绝对路径。',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对 cwd 或绝对）' },
    },
    required: ['path'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { path: rel } = args as { path: string }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)
    try {
      const content = await fs.readFile(abs, 'utf8')
      return { content }
    } catch (e) {
      return {
        content: `读取失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
