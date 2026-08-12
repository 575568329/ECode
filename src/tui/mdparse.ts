/**
 * Markdown 渲染的纯逻辑层（可单测，不依赖 marked 类型）。
 *
 * 设计思路（借鉴 Claude Code 的 formatToken，简化版）：
 * - hasMarkdownSyntax：快速路径，无 markdown 标记则跳过 lexer 直接当纯文本。
 * - inlineToAnsi：把 marked 的 inline token 序列转成 ANSI 字符串（手写 SGR，不依赖 chalk），
 *   便于后续 wrap-ansi 按显示宽度折行（wrap-ansi 是 ANSI 安全的）+ parseAnsi 回 span。
 *
 * 为什么走 ANSI 中间态而不直接 token→Ink 组件：正文折行要按中文显示宽度（全角 2 列），
 * wrap-ansi 能正确处理含 ANSI 转义的字符串（不在转义序列中间折断），所以「inline→ANSI→折行→span」
 * 是中文场景下唯一干净的路线。
 */

/** inline token 的宽松形状（解耦 marked 内部类型，降低版本耦合） */
export interface InlineTok {
  type: string
  text?: string
  raw?: string
  href?: string
  title?: string
  tokens?: InlineTok[]
}

/** 快速判定文本是否含 markdown 语法（采样前 500 字符，避免长文全扫） */
const MD_SYNTAX_RE =
  /(?:^|\n)\s*(?:#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|---|\|\s)|\[[^\]]+\]\([^)]*\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__/

export function hasMarkdownSyntax(text: string): boolean {
  if (!text) return false
  const sample = text.length > 500 ? text.slice(0, 500) : text
  return MD_SYNTAX_RE.test(sample)
}

/**
 * inline token 序列 → ANSI 字符串（SGR 码，供 wrap-ansi + parseAnsi 用）。
 * SGR 用法：粗体 1/22、斜体 3/23、dim 2/22、cyan 36/39（39 是默认前景色，cli-highlight 同款）。
 */
export function inlineToAnsi(tokens: InlineTok[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  return tokens
    .map((tok) => {
      switch (tok.type) {
        case 'text':
          // text token 可能内嵌子 token（含其他内联），递归；否则取 text
          return tok.tokens ? inlineToAnsi(tok.tokens) : (tok.text ?? '')
        case 'strong':
          return `\x1b[1m${inlineToAnsi(tok.tokens)}\x1b[22m`
        case 'em':
          return `\x1b[3m${inlineToAnsi(tok.tokens)}\x1b[23m`
        case 'codespan':
          return `\x1b[36m${tok.text ?? ''}\x1b[39m`
        case 'link':
          // M2 纯文本 linkify：text (href)（OSC 8 超链接留后续）
          return `${inlineToAnsi(tok.tokens)}\x1b[2m (${tok.href ?? ''})\x1b[22m`
        case 'image':
          return `\x1b[2m[图片${tok.text ? ': ' + tok.text : ''}]\x1b[22m`
        case 'br':
          return '\n'
        case 'escape':
        case 'html':
        case 'text_strong':
        case 'text_em':
          return tok.text ?? ''
        case 'del':
          // 删除线：MVP 不渲染，保留内容
          return inlineToAnsi(tok.tokens)
        default:
          return tok.text ?? tok.raw ?? ''
      }
    })
    .join('')
}
