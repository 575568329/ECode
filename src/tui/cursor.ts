/**
 * Cursor 字素编辑模型（M2 设计理念 §7.1-7.3）。
 *
 * - 不可变：每个操作返回新的 CursorState（原值不变），可单测、可回放。
 * - 字素级：用 Intl.Segmenter(grapheme) 切分，正确处理中文（1 字素）、emoji（含 ZWJ 组合
 *   如 👨‍👩‍👧 = 1 字素）、组合标记。caret 是**字素索引**，不是 UTF-16 索引。
 * - 将来 image chip（`[Image #N]`）作为特殊字素接入，不改架构（多模态预留）。
 *
 * 借鉴 Claude Code 的 Cursor（~1530 行含 Emacs/image-chip 等），ECode 精简到核心：
 * insert / backspace / deleteRight / move(Left/Right/Home/End)。
 */

/** 模块级 Segmenter 单例（避免每次操作重建） */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** 把字符串切成字素数组 */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

/** 字素数 */
export function countGraphemes(text: string): number {
  let n = 0
  for (const _ of segmenter.segment(text)) n++
  return n
}

/** Cursor 状态：文本 + 光标字素索引（0..字素数） */
export interface CursorState {
  text: string
  caret: number
}

/** 创建 Cursor；caret 默认在末尾 */
export function createCursor(text = ''): CursorState {
  return { text, caret: countGraphemes(text) }
}

/** 在 caret 处插入一段文本（可能多字素）；caret 移到插入内容之后 */
export function insert(cur: CursorState, chunk: string): CursorState {
  if (chunk === '') return cur
  const gs = graphemes(cur.text)
  const insertGs = graphemes(chunk)
  gs.splice(cur.caret, 0, ...insertGs)
  return { text: gs.join(''), caret: cur.caret + insertGs.length }
}

/** 删除 caret 前一个字素（Backspace） */
export function backspace(cur: CursorState): CursorState {
  if (cur.caret === 0) return cur
  const gs = graphemes(cur.text)
  gs.splice(cur.caret - 1, 1)
  return { text: gs.join(''), caret: cur.caret - 1 }
}

/** 删除 caret 处字素（Delete） */
export function deleteRight(cur: CursorState): CursorState {
  const gs = graphemes(cur.text)
  if (cur.caret >= gs.length) return cur
  gs.splice(cur.caret, 1)
  return { text: gs.join(''), caret: cur.caret }
}

export function moveLeft(cur: CursorState): CursorState {
  return cur.caret === 0 ? cur : { ...cur, caret: cur.caret - 1 }
}

export function moveRight(cur: CursorState): CursorState {
  return cur.caret >= countGraphemes(cur.text) ? cur : { ...cur, caret: cur.caret + 1 }
}

export function moveHome(cur: CursorState): CursorState {
  return cur.caret === 0 ? cur : { ...cur, caret: 0 }
}

export function moveEnd(cur: CursorState): CursorState {
  const end = countGraphemes(cur.text)
  return cur.caret === end ? cur : { ...cur, caret: end }
}

/** 按 caret 位置把文本切成三段（供反色渲染用）；caret 在末尾时 at 为空格占位 */
export function splitAtCaret(text: string, caret: number): { before: string; at: string; after: string } {
  const gs = graphemes(text)
  return {
    before: gs.slice(0, caret).join(''),
    at: gs[caret] ?? ' ',
    after: gs.slice(caret + 1).join(''),
  }
}
