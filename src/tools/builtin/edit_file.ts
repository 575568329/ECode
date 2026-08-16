/**
 * edit_file 工具（副作用）：改文件中的某段（string_replace）。
 *
 * readonly:false（串行、需确认）。详设 §4.5。
 * D1：string_replace（oldString → newString）。
 * 校验：oldString 非空 / 非同 / 唯一匹配（或 replaceAll）。
 * P1#5：Windows CRLF 归一化（按文件实际换行符转换 old/new，避免误报「0 处」）。
 * 原子写。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { Tool } from '../interface.js'

/** 统计 needle 在 haystack 中出现次数（非重叠） */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++
    i += needle.length
  }
  return count
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '改文件中的某段（string_replace）。oldString 必须唯一匹配（或 replaceAll=true）。会请求确认显示 diff。',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（必须已存在）' },
      oldString: { type: 'string', description: '要替换的原文（必须唯一匹配，或 replaceAll=true）' },
      newString: { type: 'string', description: '替换为的内容' },
      replaceAll: {
        type: 'boolean',
        description: 'true=替换所有匹配；false=仅首个（默认，且 oldString 必须唯一）',
      },
    },
    required: ['path', 'oldString', 'newString'],
  },
  readonly: false,

  async execute(args, ctx) {
    const { path: rel, oldString, newString, replaceAll = false } = args as {
      path: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    // 校验（P2#7）
    if (oldString === '') {
      return { content: 'oldString 不能为空', is_error: true }
    }
    if (oldString === newString) {
      return { content: 'oldString 与 newString 相同，无变更', is_error: true }
    }

    const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)
    // M9-P4：沙箱前置校验（read-only 拒 / workspace-write 越界拒；软沙箱在工具层）
    const gate = ctx.sandbox?.checkWrite(abs)
    if (gate !== undefined && !gate.ok) return { content: gate.reason, is_error: true }
    // M9-P1：写前快照（失败不阻断——安全网自身的问题不挡主流程）
    try {
      await ctx.onBeforeWrite?.([abs], 'edit_file')
    } catch {
      /* 快照失败静默继续（装配方 warn 已记） */
    }
    try {
      const oldContent = await fs.readFile(abs, 'utf8')

      // CRLF 归一化（P1#5）：按文件实际换行符转换 old/new
      const nl = oldContent.includes('\r\n') ? '\r\n' : '\n'
      const oldN = oldString.replace(/\r?\n/g, nl)
      const newN = newString.replace(/\r?\n/g, nl)

      const count = countOccurrences(oldContent, oldN)
      if (count === 0) {
        return {
          content: `oldString 在 ${rel} 中未找到（可能内容已被改过，或 oldString 不够精确；可用 read_file 看当前内容）`,
          is_error: true,
        }
      }
      if (!replaceAll && count > 1) {
        return {
          content: `oldString 在 ${rel} 中匹配 ${count} 处，需要更精确的上下文（或设 replaceAll=true）`,
          is_error: true,
        }
      }

      const newContent = replaceAll
        ? oldContent.split(oldN).join(newN)
        : oldContent.replace(oldN, newN)

      // 原子写
      const tmp = abs + '.ecode-tmp'
      await fs.writeFile(tmp, newContent, 'utf8')
      await fs.rename(tmp, abs)
      // result 含 diff（执行时原文件还在，能算完整 unified diff；详设 §7.5：Static 事后可回顾）
      const diff = createTwoFilesPatch(rel, rel, oldContent, newContent, '', '', { context: 2 })
      return {
        content: `已更新 ${rel}（${count === 1 ? '1 处' : `${count} 处`}）\n\n${diff}`,
      }
    } catch (e) {
      return {
        content: `edit 失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
