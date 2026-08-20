/**
 * grep 工具（只读）：搜文件内容（正则）。
 *
 * readonly:true（免确认、可并行）。详设 §2.3 行 233 / §4.3。
 * fast-glob 取文件 + RegExp 匹配，纯 JS 跨平台一致。性能不足后续切 ripgrep。
 * MVP 不支持 -A/-B/-C 上下文（LLM 可用 read_file 看上下文）。
 */

import fg from 'fast-glob'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Tool } from '../interface.js'
import { loadEcodeIgnore } from '../../services/ignore.js'
import { isSensitivePath, sensitiveGate } from '../sensitive.js'

/** 匹配截断阈值（防巨量匹配刷屏） */
const MAX_MATCHES = 100

export const grepTool: Tool = {
  name: 'grep',
  description: '搜文件内容（正则）。返回 path:line: 匹配行。glob 可限定文件类型。',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索根目录（默认 cwd）' },
      glob: { type: 'string', description: '文件名过滤（如 *.ts，默认所有文件）' },
    },
    required: ['pattern'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { pattern, path: rel, glob } = args as {
      pattern: string
      path?: string
      glob?: string
    }
    const cwd = rel ? (path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)) : ctx.cwd
    const ig = loadEcodeIgnore(ctx.cwd)

    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return {
        content: `正则无效: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }

    try {
      // path 是文件 → 只搜该文件（避免 fast-glob 把文件当目录 scandir → ENOTDIR）
      const stat = await fs.stat(cwd).catch(() => null)
      if (stat?.isFile()) {
        // 敏感门与 read_file 同款（复审 P0：本工具曾可旁路 read_file 的门直读密钥文件）
        const denied = await sensitiveGate(cwd, ctx, 'grep')
        if (denied !== undefined) return denied
        const content = await fs.readFile(cwd, 'utf8')
        const fileLines = content.split('\n')
        const matched: string[] = []
        for (let i = 0; i < fileLines.length; i++) {
          if (re.test(fileLines[i])) {
            matched.push(`${rel ?? cwd}:${i + 1}: ${fileLines[i].trim()}`)
          }
        }
        return { content: matched.length > 0 ? matched.join('\n') : '(无匹配)' }
      }
      const files = await fg(glob ?? '**/*', {
        cwd,
        caseSensitiveMatch: true,
        onlyFiles: true,
        ignore: ig.patterns,
        unique: true,
      })
      const lines: string[] = []
      let total = 0
      let skippedSensitive = 0
      for (const file of files) {
        if (total >= MAX_MATCHES) break
        if (ig.ignores(file)) continue
        // 目录游走逐文件过滤敏感路径（游走中途逐文件弹确认太吵——跳过并在结果尾注明；
        // 用户确需搜某个敏感文件可单独指定 path 让 sensitiveGate 弹确认）
        if (isSensitivePath(path.join(cwd, file))) {
          skippedSensitive++
          continue
        }
        try {
          const content = await fs.readFile(path.join(cwd, file), 'utf8')
          const fileLines = content.split('\n')
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i])) {
              lines.push(`${file}:${i + 1}: ${fileLines[i].trim()}`)
              total++
              if (total >= MAX_MATCHES) break
            }
          }
        } catch {
          // 读失败（二进制/权限）跳过该文件
        }
      }
      if (lines.length === 0 && skippedSensitive === 0) return { content: '(无匹配)' }
      if (total >= MAX_MATCHES) lines.push(`…（达上限 ${MAX_MATCHES}，可能还有更多）`)
      if (skippedSensitive > 0) lines.push(`（已跳过 ${skippedSensitive} 个敏感文件；如确需搜索请单独指定该文件路径触发用户确认）`)
      return { content: lines.length > 0 ? lines.join('\n') : '(无匹配)' }
    } catch (e) {
      return {
        content: `grep 失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
