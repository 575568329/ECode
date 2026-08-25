/**
 * ANSI 安全的智能折行（表格单元格 / key-value 值用）。
 *
 * 策略（codex adaptive_wrap 理念在窄列场景的适配）：
 * - 空白处优先断行；词能独占一行就独占（URL 在宽行整体保留，终端可点击）；
 * - 超过行宽的长 token（URL / 路径 / 哈希）在其语义边界（/ ? = & . , ; : - _ 等
 *   之后）或 CJK 宽字符之间断开——列宽只有 15~20 时 URL 必然放不下整条，
 *   断在语义边界让每段可辨认（api/presBasic/ | getRppQuestion? | taskId=）；
 * - 完全没有断点的长游程（如十六进制哈希）才按显示宽度硬切。
 *
 * 为什么不用 wrap-ansi：它只按空格分词，超宽 token 在任意字符处硬折
 * （…getRp / pQuestion…），且没有自定义断点的钩子。
 *
 * 实现要点：parseAnsi 先展开为 span，折行在纯文本上做（宽度 string-width，
 * 中文 1 字 2 列），输出行按 span 属性重新套 SGR，parseAnsi 可无损回读。
 * 单元格内的换行/连续空白会归一为单空格（markdown 表格单元格本就不该有换行）。
 */
import stringWidth from 'string-width'
import { parseAnsi, attrsToAnsi, type Span } from './ansi.js'

/** token 内的语义断点：这些字符之后允许断行（URL / 路径的自然边界） */
const BREAK_AFTER = new Set(['/', '?', '=', '&', '.', ',', ';', ':', '-', '_', '~', '#', '%', '+', '@'])

type Attrs = Omit<Span, 'text'>

/** 单个折行片段：纯文本 + 所属 span 属性 */
interface Piece {
  text: string
  attrs: Attrs
}

/** 两个 span 属性是否等价（序列化前合并相邻同属性片段用） */
function sameAttrs(a: Attrs, b: Attrs): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dimColor === b.dimColor
  )
}

/**
 * 把超宽 token 切成可断片段：语义断点字符后断、CJK 宽字符后断；
 * 无断点的游程超过 limit 时按显示宽度硬切（保证每片 ≤ limit，宽字符切不动除外）。
 */
function splitAtBoundaries(token: string, limit: number): string[] {
  const pieces: string[] = []
  let current = ''
  let currentWidth = 0
  for (const ch of token) {
    const w = stringWidth(ch)
    if (currentWidth > 0 && currentWidth + w > limit) {
      pieces.push(current)
      current = ''
      currentWidth = 0
    }
    current += ch
    currentWidth += w
    if (BREAK_AFTER.has(ch) || w >= 2) {
      pieces.push(current)
      current = ''
      currentWidth = 0
    }
  }
  if (currentWidth > 0) pieces.push(current)
  return pieces
}

/** 一行片段序列化为 ANSI 字符串：相邻同属性合并，套 SGR 开码 + 全复位 */
function serializeLine(pieces: Piece[]): string {
  const merged: Piece[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (last !== undefined && sameAttrs(last.attrs, piece.attrs)) last.text += piece.text
    else merged.push({ ...piece })
  }
  return merged
    .map((p) => {
      const open = attrsToAnsi(p.attrs)
      return open !== '' ? open + p.text + '\u001b[0m' : p.text
    })
    .join('')
}

/**
 * 按显示宽度智能折行 ANSI 字符串（含 \n 的输入按空白归一处理）。
 * 每行显示宽度 ≤ width（单个宽字符超过 width 时无法再切，属不可避免溢出）。
 */
export function smartWrapAnsi(text: string, width: number): string {
  if (width <= 0 || text === '') return text
  const lines: Piece[][] = [[]]
  let lineWidth = 0
  let pendingSpace = false

  const push = (pieceText: string, attrs: Attrs): void => {
    lines[lines.length - 1].push({ text: pieceText, attrs })
    lineWidth += stringWidth(pieceText)
  }
  const newLine = (): void => {
    lines.push([])
    lineWidth = 0
    pendingSpace = false
  }

  for (const span of parseAnsi(text)) {
    const { text: spanText, ...attrs } = span
    for (const word of spanText.split(/\s+/)) {
      if (word === '') continue
      const wordWidth = stringWidth(word)
      const sepWidth = pendingSpace && lineWidth > 0 ? 1 : 0
      if (lineWidth + sepWidth + wordWidth <= width) {
        if (sepWidth > 0) push(' ', attrs)
        push(word, attrs)
        pendingSpace = true
        continue
      }
      if (wordWidth <= width) {
        // 整词放得下一行：换行独占，词保持完整（URL 在宽行整体保留）
        newLine()
        push(word, attrs)
        pendingSpace = true
        continue
      }
      // 超过整行宽的长 token：按断点切片贪心装行（首片尽量接在当前行）
      const pieces = splitAtBoundaries(word, width)
      let first = true
      for (const piece of pieces) {
        const pieceSep = first ? sepWidth : 0
        if (lineWidth > 0 && lineWidth + pieceSep + stringWidth(piece) > width) newLine()
        if (pieceSep > 0 && lineWidth > 0) push(' ', attrs)
        push(piece, attrs)
        first = false
      }
      pendingSpace = true
    }
  }
  return lines.map(serializeLine).join('\n')
}
