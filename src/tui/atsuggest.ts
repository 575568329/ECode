/**
 * @ 文件路径补全（界面批 A1）：纯逻辑层——查询词提取 + fast-glob 候选匹配。
 *
 * 触发形态：光标前最近一个 `@`，与其后的连续路径段（字母/数字/._/-/\/）构成查询词；
 * `@` 之前的字符必须是行首或空白（防 email/装饰性 @ 误触发）。
 * 候选：cwd 相对路径前缀匹配，目录优先、限 10 条；排除隐藏文件与 .ecode/、node_modules/
 * （复用 loadEcodeIgnore 的默认忽略清单——常识级，不做全量 gitignore）。
 *
 * 键位（InputStream 接线）：↑↓ 选择 / Tab·Enter 补全为 `@路径 `（尾随空格续写）/ Esc 关闭。
 */

import fg from 'fast-glob'
import { loadEcodeIgnore } from '../services/ignore.js'

/** 候选上限（UI 线下拉同款窗口：候选行入动态区预算——限 10 条封顶） */
export const AT_MAX_ENTRIES = 10

/** @ 补全候选条目（dir=true 目录——补全后可继续续写下一级） */
export interface AtEntry {
  /** cwd 相对路径（正斜杠） */
  rel: string
  dir: boolean
}

/**
 * 从输入文本提取 @ 查询词（光标位置感知）。
 * 返回 undefined = 无激活的 @ 补全；返回 { atIdx, query } = 光标前最近一个 @ 的下标与查询词。
 * 查询词为 @ 后的连续路径段；@ 后遇空格等非法字符即失效（`@ 已过期`——须紧跟路径）。
 */
export function extractAtQuery(text: string, caret: number): { atIdx: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const atIdx = before.lastIndexOf('@')
  if (atIdx === -1) return undefined
  // @ 前必须是行首或空白（防 email：`a@b` 不触发）
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1] ?? '')) return undefined
  const query = before.slice(atIdx + 1)
  if (query === '') return { atIdx, query: '' } // 裸 @ = 列顶层（目录优先）
  // 查询词必须是连续路径段字符（字母数字._-/ 与反斜杠）；含空格=已过期
  if (!/^[\w./\\-]+$/.test(query)) return undefined
  return { atIdx, query: query.replace(/\\/g, '/') }
}

/** 列目录候选（目录优先 + 前缀匹配；含查询词已是完整路径时的自身提示） */
export async function listAtEntries(cwd: string, query: string): Promise<AtEntry[]> {
  const ig = loadEcodeIgnore(cwd)
  const q = query.toLowerCase()
  const fgOpts: Parameters<typeof fg>[1] = {
    cwd,
    caseSensitiveMatch: true,
    onlyFiles: false,
    dot: false, // 隐藏文件不列
    ignore: [...ig.patterns, '.ecode/**'],
    unique: true,
  }
  let matches: string[]
  try {
    matches = await fg(q === '' ? '*' : `${q}*`, {
      ...fgOpts,
      deep: 3, // 顶层 3 层内（大仓库常识级范围；更深的路径靠逐级续写缩小）
    })
  } catch {
    return []
  }
  const norm = matches.map((m) => m.replace(/\\/g, '/'))
  // 查询词自身是完整目录时（如 `@src`）子项优先列出（续写下一级比前缀续写更符合直觉）
  let subs: string[] = []
  if (q !== '' && !q.endsWith('/')) {
    try {
      const r = await fg(`${q}/*`, { ...fgOpts, deep: 1 })
      if (r.length > 0 && r.every((s) => s.replace(/\\/g, '/').startsWith(`${q}/`))) {
        subs = r.map((s) => s.replace(/\\/g, '/'))
      }
    } catch {
      /* 子项列举失败回退主匹配 */
    }
  }
  const entryOf = (rel: string): AtEntry | null => {
    if (rel === '') return null
    if (ig.ignores(rel)) return null
    // 隐藏段（任意一级以 . 开头）不列——dot:false 只管首段，深层补齐
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return null
    return { rel, dir: !rel.includes('.') || /\.[^/]*$/.test(rel) === false }
  }
  // 目录判定修正：fast-glob onlyFiles:false 时目录路径不带尾 /，以「无扩展名段」启发不可靠——
  // 用「主匹配+子项候选集中存在以其为前缀的更深层路径」判目录（含子项的必是目录）
  const all = [...norm, ...subs]
  const prefixSet = new Set<string>()
  for (const m of all) {
    const parts = m.split('/')
    parts.pop()
    for (let i = 1; i <= parts.length; i++) prefixSet.add(parts.slice(0, i).join('/'))
  }
  const seen = new Set<string>()
  const entries: AtEntry[] = []
  const push = (rel: string): void => {
    if (seen.has(rel)) return
    seen.add(rel)
    const e = entryOf(rel)
    if (e !== null) entries.push({ ...e, dir: prefixSet.has(rel) })
  }
  // 子项优先（查询词已是目录时），再主匹配
  for (const s of subs) push(s)
  for (const m of norm) push(m)
  // 目录优先，其余按路径字典序
  entries.sort((a, b) => (a.dir === b.dir ? a.rel.localeCompare(b.rel) : a.dir ? -1 : 1))
  return entries.slice(0, AT_MAX_ENTRIES)
}

/** 补全文本替换：`@query` → `@rel `（尾随空格续写；目录加尾 / 方便续写下一级）。
 * 替换范围 = @ 起到查询词末尾（查询词字符集内），@ 段之后的光标右侧文本原样保留。 */
export function applyAtCompletion(text: string, atIdx: number, entry: AtEntry): string {
  const before = text.slice(0, atIdx)
  let end = atIdx + 1
  while (end < text.length && /[\w./\\-]/.test(text[end] ?? '')) end++
  const rest = text.slice(end)
  return `${before}@${entry.rel}${entry.dir ? '/' : ' '}${rest}`
}
