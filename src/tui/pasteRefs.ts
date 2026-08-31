/**
 * 粘贴 token（输入体验批二期，学 CC 「[Pasted text #N +M lines]」设计理念）：
 * 大粘贴不进输入框——存内存 map，草稿里放短 token，提交时展开回全文。
 *
 * 阈值与格式对标 CC：单次粘贴 > PASTE_THRESHOLD(800) 字符或行数 > 2 即 token 化
 * （行数口径同 CC：换行符计数，"a\nb\nc" = +2 行）；无换行的超长单行用无行数后缀形态。
 * parseReferences/expand 按**解析位置 splice 且倒序替换**——粘贴内容里出现的
 * 「[粘贴#2]」字样是普通文本，不会被误当 token 展开（CC 同款防御）。
 */

/** token 化阈值：字符数（CC PASTE_THRESHOLD 同值） */
export const PASTE_THRESHOLD = 800
/** token 化阈值：行数（CC maxLines=min(rows-10,2) 的简化口径） */
export const PASTE_LINE_THRESHOLD = 2

/** 生成 token 文本：有换行带 +N 行（N=换行符数，CC 同口径），无换行短形态 */
export function formatPasteRef(id: number, text: string): string {
  const numLines = (text.match(/\r\n|\r|\n/g) || []).length
  return numLines === 0 ? `[粘贴#${id}]` : `[粘贴#${id} +${numLines} 行]`
}

/** 是否该 token 化（CC 条件：字符数超阈或行数超阈） */
export function shouldTokenize(text: string): boolean {
  return text.length > PASTE_THRESHOLD || (text.match(/\r\n|\r|\n/g) || []).length > PASTE_LINE_THRESHOLD
}

export interface PasteRefMatch {
  id: number
  match: string
  index: number
}

/** 解析草稿中的粘贴 token（含图片外的文本形态；贪婪匹配 +N 行可选段） */
export function parsePasteRefs(input: string): PasteRefMatch[] {
  const matches = [...input.matchAll(/\[粘贴#(\d+)(?: \+\d+ 行)?\]/g)]
  return matches
    .map((m) => ({ id: parseInt(m[1] ?? '0', 10), match: m[0], index: m.index ?? 0 }))
    .filter((m) => m.id > 0)
}

/**
 * 展开草稿中的 token 为存储全文（提交前调用）。倒序按原偏移 splice——
 * 粘贴内容里的「[粘贴#2]」字样不会被二次展开（CC expandPastedTextRefs 同款防御）。
 * 无对应存储条目的 token 保持原样（历史草稿恢复等场景不炸）。
 */
export function expandPasteRefs(input: string, store: ReadonlyMap<number, string>): string {
  const refs = parsePasteRefs(input)
  let expanded = input
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]
    if (ref === undefined) continue
    const content = store.get(ref.id)
    if (content === undefined) continue
    expanded = expanded.slice(0, ref.index) + content + expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}

/** 剪枝：删除草稿里已无 token 引用的粘贴条目 id（CC prune images 同款——删标签=删内容） */
export function prunePasteRefs(store: ReadonlyMap<number, string>, draft: string): number[] {
  const dead: number[] = []
  for (const id of store.keys()) {
    if (!parsePasteRefs(draft).some((r) => r.id === id)) dead.push(id)
  }
  return dead
}
