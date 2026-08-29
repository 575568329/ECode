/**
 * write_file 工具（副作用）：写新文件或覆盖。
 *
 * readonly:false（串行、需确认）。详设 §4.4。
 * 原子写（写 .tmp → rename，中断不留半截）。
 * 2026-08-29：覆盖已有文件时结果附带完整 unified diff（用户拍板「改动必须显示全量 diff」——
 * 整文件覆盖是摧毁性最高的黑盒；新文件无「改动」可显保持一行；超大旧文件跳过 diff 防
 * jsdiff 代价失控，反正结果也会被 F-39 50KB 截断）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { fixPatchHeaders } from './patchHeader.js'
import type { Tool } from '../interface.js'

/** 旧文件超过此大小不做 diff（jsdiff Myers 在超大串上代价高，且结果必超 F-39 50KB 截断线） */
const DIFF_SKIP_BYTES = 2 * 1024 * 1024

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    '写新文件或覆盖文件（UTF-8，原子写）。覆盖已有文件时结果附带完整 unified diff。path 相对 cwd 或绝对。会请求确认。编辑 .ecode/settings*（权限规则）属安全敏感操作：改了哪条规则必须在回复中明确告知用户。',
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
      // 写前读旧内容算 diff（仅存在的常规文件且不超大小护栏；失败静默视作新文件——
      // diff 是展示物不是栅栏，读不到就别挡写入）
      let oldContent: string | null = null
      try {
        const stat = await fs.stat(abs)
        if (stat.isFile() && stat.size <= DIFF_SKIP_BYTES) oldContent = await fs.readFile(abs, 'utf8')
      } catch {
        /* 不存在 → 新文件 */
      }
      // 原子写：写 .tmp → rename（中断不留半截）
      const tmp = abs + '.ecode-tmp'
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, abs)
      const lines = content.split('\n').length
      if (oldContent === null) return { content: `已写入 ${rel}（${lines} 行）` }
      if (oldContent === content) return { content: `已写入 ${rel}（${lines} 行，内容未变化）` }
      const diff = fixPatchHeaders(createTwoFilesPatch(rel, rel, oldContent, content, '', '', { context: 2 }))
      return { content: `已写入 ${rel}（${lines} 行，覆盖）\n\n${diff}` }
    } catch (e) {
      return {
        content: `写入失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
