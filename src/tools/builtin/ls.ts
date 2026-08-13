/**
 * ls 工具（只读）：列目录内容 + 元信息。
 *
 * readonly:true（免确认、可并行）。详设 §2.3 行 230 / §4.1。
 * 纯 JS（fs.readdir + fs.stat），按 depth 递归，.ecodeignore 过滤。
 * MVP 不显示权限字段（Windows chmod 语义不同）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Tool } from '../interface.js'
import { loadEcodeIgnore, type EcodeIgnore } from '../../services/ignore.js'

export const lsTool: Tool = {
  name: 'ls',
  description: '列出目录内容（文件/子目录 + 类型/大小/修改时间）。path 可相对 cwd 或绝对。',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（相对 cwd 或绝对）' },
      depth: {
        type: 'integer',
        minimum: 1,
        maximum: 3,
        description: '递归深度（1=只列本层，默认 1）',
      },
      all: { type: 'boolean', description: '是否含隐藏文件（. 开头，默认 false）' },
    },
    required: ['path'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { path: rel, depth = 1, all = false } = args as {
      path: string
      depth?: number
      all?: boolean
    }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)
    try {
      const ig = loadEcodeIgnore(ctx.cwd)
      const lines: string[] = []
      await walk(abs, '', depth, all, ig, lines)
      return { content: lines.length > 0 ? lines.join('\n') : '(空目录)' }
    } catch (e) {
      return {
        content: `ls 失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}

/** 递归遍历目录，收集 `rel\t[type]\tsize\tmtime` 行。 */
async function walk(
  absDir: string,
  relPrefix: string,
  depth: number,
  all: boolean,
  ig: EcodeIgnore,
  lines: string[],
): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    // 隐藏文件过滤
    if (!all && entry.name.startsWith('.')) continue
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    // .ecodeignore 过滤
    if (ig.ignores(rel)) continue
    try {
      const stat = await fs.stat(path.join(absDir, entry.name))
      const type = entry.isDirectory() ? 'dir' : 'file'
      const mtime = stat.mtime.toISOString().slice(0, 10)
      lines.push(`${rel}\t[${type}]\t${stat.size}B\t${mtime}`)
      if (entry.isDirectory() && depth > 1) {
        await walk(path.join(absDir, entry.name), rel, depth - 1, all, ig, lines)
      }
    } catch {
      // stat 失败（权限/符号链接等）跳过该条
    }
  }
}
