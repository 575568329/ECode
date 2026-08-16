/**
 * write_file 工具（副作用）：写新文件或覆盖。
 *
 * readonly:false（串行、需确认）。详设 §4.4。
 * 原子写（写 .tmp → rename，中断不留半截）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Tool } from '../interface.js'

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    '写新文件或覆盖文件（UTF-8，原子写）。path 相对 cwd 或绝对。会请求确认。编辑 .ecode/settings*（权限规则）属安全敏感操作：改了哪条规则必须在回复中明确告知用户。',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  readonly: false,

  async execute(args, ctx) {
    const { path: rel, content } = args as { path: string; content: string }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)
    // M9-P4：沙箱前置校验（read-only 拒 / workspace-write 越界拒；软沙箱在工具层）
    const gate = ctx.sandbox?.checkWrite(abs)
    if (gate !== undefined && !gate.ok) return { content: gate.reason, is_error: true }
    // M9-P1：写前快照（失败不阻断——安全网自身的问题不挡主流程）
    try {
      await ctx.onBeforeWrite?.([abs], 'write_file')
    } catch {
      /* 快照失败静默继续（装配方 warn 已记） */
    }
    try {
      // 原子写：写 .tmp → rename（中断不留半截）
      const tmp = abs + '.ecode-tmp'
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, abs)
      const lines = content.split('\n').length
      return { content: `已写入 ${rel}（${lines} 行）` }
    } catch (e) {
      return {
        content: `写入失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
