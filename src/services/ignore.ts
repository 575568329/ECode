/**
 * .ecodeignore 加载（M3，详设 §2.3 行 235 / §6）。
 *
 * 三工具（ls/glob/grep）共用。格式 gitignore 兼容（用 `ignore` 包解析）。
 * - 默认忽略：node_modules / .git / .env* / dist / build（防扫巨量文件 / 密钥进 context）
 * - 合并 cwd/.ecodeignore（用户自定义）
 *
 * MVP 只读 cwd 一份，不向上查找（简化；后续可加向上合并）。
 */

import ignore from 'ignore'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 默认忽略规则（详设 §2.3 行 235） */
const DEFAULT_IGNORE = ['node_modules/', '.git/', '.env*', 'dist/', 'build/']

export interface EcodeIgnore {
  /** glob 模式数组（给 fast-glob 的 ignore 选项，避免扫巨量文件如 node_modules） */
  patterns: string[]
  /** gitignore 标准判断（给 ls/grep 结果 filter，处理 .ecodeignore 的复杂规则） */
  ignores: (path: string) => boolean
}

/**
 * 加载 .ecodeignore：默认 + cwd/.ecodeignore 合并。
 * @param cwd 工作目录（默认 process.cwd()）
 */
export function loadEcodeIgnore(cwd: string = process.cwd()): EcodeIgnore {
  const patterns = [...DEFAULT_IGNORE]
  const file = join(cwd, '.ecodeignore')
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    // 过滤空行 + 注释（# 开头）
    patterns.push(...lines.filter((l) => {
      const t = l.trim()
      return t !== '' && !t.startsWith('#')
    }))
  }
  const ig = ignore().add(patterns)
  return {
    patterns,
    ignores: (p: string) => ig.ignores(p),
  }
}
