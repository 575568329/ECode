/**
 * Ansi 桥：最小 SGR-only 解析器。
 *
 * 把 cli-highlight 产出的 ANSI 字符串（仅 SGR 码 `\x1b[...m`）解析成 span 数组，
 * 供 Ink `<Text>` 直接渲染。不处理 CSI/OSC/DEC 全集（cli-highlight 不发）。
 *
 * 注意：claude-code-main 的 Ansi.tsx 依赖它自己 fork 的 Ink 的 termio 全集（9 文件），
 * ECode 用 stock Ink 没有那个模块——此处自写最小子集（~80 行）。
 */

/** 单个文本片段 + SGR 属性（字段名与 Ink <Text> props 对齐，渲染可直接展开） */
export interface Span {
  text: string
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dimColor?: boolean
}

/** SGR 前景色码 → Ink 颜色名 */
const FG_COLORS: Record<number, string> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
  34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'blackBright', 91: 'redBright', 92: 'greenBright', 93: 'yellowBright',
  94: 'blueBright', 95: 'magentaBright', 96: 'cyanBright', 97: 'whiteBright',
}

/** SGR 背景色码 → Ink 颜色名 */
const BG_COLORS: Record<number, string> = {
  40: 'black', 41: 'red', 42: 'green', 43: 'yellow',
  44: 'blue', 45: 'magenta', 46: 'cyan', 47: 'white',
  100: 'blackBright', 101: 'redBright', 102: 'greenBright', 103: 'yellowBright',
  104: 'blueBright', 105: 'magentaBright', 106: 'cyanBright', 107: 'whiteBright',
}

/** 当前 SGR 属性状态（解析器内部用，不含 text） */
interface Attrs {
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dimColor?: boolean
}

/** 应用一组 SGR 参数到属性状态（就地修改） */
function applySGR(attrs: Attrs, params: string): void {
  // 空 params 等价于 reset（SGR 0）
  const codes = params === '' ? [0] : params.split(';').map((s) => Number(s))
  for (const code of codes) {
    if (Number.isNaN(code)) continue
    if (code === 0) {
      delete attrs.color
      delete attrs.backgroundColor
      delete attrs.bold
      delete attrs.italic
      delete attrs.underline
      delete attrs.dimColor
    } else if (code === 1) {
      attrs.bold = true
    } else if (code === 2) {
      attrs.dimColor = true
    } else if (code === 3) {
      attrs.italic = true
    } else if (code === 4) {
      attrs.underline = true
    } else if (code === 22) {
      // 22 = 既非粗体也非 dim
      delete attrs.bold
      delete attrs.dimColor
    } else if (code === 23) {
      delete attrs.italic
    } else if (code === 24) {
      delete attrs.underline
    } else if (code === 39) {
      // 39 = 默认前景色（cli-highlight 实际用 39 而非 0 来 reset 前景）
      delete attrs.color
    } else if (code === 49) {
      // 49 = 默认背景色
      delete attrs.backgroundColor
    } else if (FG_COLORS[code] !== undefined) {
      attrs.color = FG_COLORS[code]
    } else if (BG_COLORS[code] !== undefined) {
      attrs.backgroundColor = BG_COLORS[code]
    }
    // 其他 SGR 码（256 色 38;5;n、RGB 38;2;r;g;b、下划线色等）MVP 不处理，忽略
  }
}

/**
 * 解析含 SGR 转义的字符串为 span 数组。
 *
 * - 仅处理 SGR（`\x1b[...m`）；其他 CSI 序列（清屏/光标移动）被忽略并跳过；
 * - 裸 ESC 字符（非 CSI）被跳过；
 * - 属性不变时不产生多余 span，相邻同属性文本自然合并。
 */
export function parseAnsi(input: string): Span[] {
  const spans: Span[] = []
  const attrs: Attrs = {}
  let buf = ''
  let i = 0

  const flush = (): void => {
    if (buf.length > 0) {
      spans.push({ text: buf, ...attrs })
      buf = ''
    }
  }

  while (i < input.length) {
    const ch = input[i]
    if (ch === '\x1b') {
      if (input[i + 1] === '[') {
        // CSI 序列：\x1b[ <params> <final-letter>
        let j = i + 2
        while (j < input.length && !/[A-Za-z]/.test(input[j] as string)) j++
        const finalChar = input[j]
        const params = input.slice(i + 2, j)
        if (finalChar === 'm') {
          flush()
          applySGR(attrs, params)
        }
        // 非 SGR 的 CSI 忽略（不 flush、不改属性）
        i = j + 1
      } else {
        // 非 CSI 的 ESC（OSC 等）—— cli-highlight 不发，跳过 ESC 字符
        i += 1
      }
    } else {
      buf += ch
      i += 1
    }
  }
  flush()
  return spans
}
