/**
 * glob 工具（只读）：按模式匹配找文件路径。
 *
 * readonly:true（免确认、可并行）。详设 §2.3 行 232 / §4.2。
 * fast-glob + caseSensitiveMatch:true（D7，跨 OS 一致）+ .ecodeignore 过滤。
 */

import fg from 'fast-glob'
import * as path from 'node:path'
import type { Tool } from '../interface.js'
import { isSensitivePath } from '../sensitive.js'
import { loadEcodeIgnore } from '../../services/ignore.js'

/** 结果截断阈值（防巨量匹配刷屏） */
const MAX_RESULTS = 500

export const globTool: Tool = {
  name: 'glob',
  description: '按 glob 模式匹配文件路径（如 **/*.ts）。返回匹配路径列表（正斜杠）。',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（如 **/*.ts，正斜杠跨平台）' },
      path: { type: 'string', description: '搜索根目录（相对 cwd 或绝对，默认 cwd）' },
    },
    required: ['pattern'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { pattern, path: rel } = args as { pattern: string; path?: string }
    const cwd = rel ? (path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)) : ctx.cwd
    const ig = loadEcodeIgnore(ctx.cwd)
    try {
      const matches = await fg(pattern, {
        cwd,
        caseSensitiveMatch: true, // D7：跨 OS 一致
        onlyFiles: true,
        ignore: ig.patterns,
        unique: true,
      })
      // 额外 filter：fast-glob ignore 与 gitignore 语义有差异，用 ignore 库兜底
      const filtered = matches.filter((m) => !ig.ignores(m))
      // 审阅修复（安全席 P2·二轮）：敏感路径过滤对齐 grep——原 glob 零防护，任意目录
      // 文件名枚举（含 ~/.ssh 清单）是侦察原语
      const safe: string[] = []
      let skipped = 0
      for (const m of filtered) {
        if (isSensitivePath(path.join(cwd, m))) skipped += 1
        else safe.push(m)
      }
      const skipNote = skipped > 0 ? `\n（已跳过 ${skipped} 个敏感路径）` : ''
      if (safe.length === 0) return { content: `(无匹配${skipped > 0 ? `，${skipped} 个敏感路径已跳过` : ''})` }
      if (safe.length > MAX_RESULTS) {
        return {
          content:
            safe.slice(0, MAX_RESULTS).join('\n') +
            `\n…（共 ${safe.length} 个匹配，已截断到 ${MAX_RESULTS}）${skipNote}`,
        }
      }
      return { content: safe.join('\n') + skipNote }
    } catch (e) {
      return {
        content: `glob 失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
