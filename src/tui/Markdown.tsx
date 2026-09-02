import { useState, useEffect, Fragment } from 'react'
import { memo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Text, Box } from 'ink'
import { marked } from 'marked'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import Table from 'cli-table3'
import { parseAnsi, type Span } from './ansi.js'
import { smartWrapAnsi } from './wrap.js'
import { hasMarkdownSyntax, inlineToAnsi, type InlineTok } from './mdparse.js'
import { GAP, WIDTH } from './layout.js'
import { theme } from './theme.js'

/**
 * Markdown 渲染组件（M2 阶段一：静态 markdown，给已 commit 的助手消息用）。
 *
 * 架构（借鉴 Claude Code，简化）：
 *   marked.lexer → block tokens → 按 type 映射 Ink 原语
 *   inline tokens → inlineToAnsi（ANSI 字符串）→ wrap-ansi（中文按显示宽度折行）→ parseAnsi → <Text> spans
 *   代码块 → cli-highlight（动态懒加载，TTY 下着色）→ parseAnsi → <Box borderStyle="round">
 *   表格 → cli-table3（列宽按终端宽自适应 + wrap-ansi 预折行；折行超限降级 key-value 垂直格式）→ parseAnsi → <Text>
 *
 * 流式 markdown（阶段二，remend + stable/unstable 切分）见 M2 方案 B.2，M2 不做。
 */

/** block token 的宽松形状（解耦 marked 内部联合类型，降低版本耦合） */
interface BlockTok {
  type: string
  depth?: number
  text?: string
  lang?: string
  tokens?: BlockTok[]
  items?: BlockTok[]
  ordered?: boolean
  start?: number
  header?: Array<{ text?: string; tokens?: InlineTok[] }>
  rows?: Array<Array<{ text?: string; tokens?: InlineTok[] }>>
  raw?: string
}

/** 渲染列宽：正文列宽（F-36——Markdown 住在 MessageRow 圆点槽右侧，预折宽=内容列宽，
 *  续行对齐第 2 列；上限 100 避免过宽难读。排版批②：公式归一 layout.ts WIDTH） */
function cols(): number {
  return WIDTH.body(process.stdout.columns || 80)
}

/** 去掉 text 字段，剩余作为 Ink <Text> 的样式 props（rest 解构不算 unused） */
function spanProps(span: Span): Omit<Span, 'text'> {
  const { text, ...props } = span
  return props
}

/** 把 ANSI 字符串渲染成带样式的 <Text>（可选按显示宽度折行；wrap-ansi hard 模式对中文安全） */
function AnsiText({ ansi, wrap }: { ansi: string; wrap: boolean }): ReactElement {
  const text = wrap ? wrapAnsi(ansi, cols(), { hard: true }) : ansi
  const spans = parseAnsi(text)
  return (
    <Text>
      {spans.map((s, i) => (
        <Text key={i} {...spanProps(s)}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

// cli-highlight 是 CJS，ESM 下动态 import + 模块级共享单例 Promise（懒加载，成本只付一次）
type HighlightFn = (code: string, opts?: { language?: string }) => string
type SupportsLanguageFn = (language: string) => boolean
let hlPromise: Promise<{ hl: HighlightFn; supports: SupportsLanguageFn }> | null = null
function loadHighlight(): Promise<{ hl: HighlightFn; supports: SupportsLanguageFn }> {
  if (!hlPromise) {
    hlPromise = import('cli-highlight').then((m) => {
      const d = m as typeof m & { default?: { highlight?: HighlightFn; supportsLanguage?: SupportsLanguageFn } }
      const hl = m.highlight ?? d.default?.highlight
      const supports = m.supportsLanguage ?? d.default?.supportsLanguage
      if (typeof hl !== 'function' || typeof supports !== 'function') {
        throw new Error('cli-highlight.highlight/supportsLanguage not found')
      }
      return { hl, supports }
    })
  }
  return hlPromise
}

/** 高频围栏别名 → highlight.js 注册名。jsonc/json5 是 highlight.js 未收录的语言（LLM 写
 *  settings/配置类回复的高频围栏），映射到 json 照常高亮；其余不认识的走纯文本降级。 */
const LANG_ALIASES: Record<string, string> = { jsonc: 'json', json5: 'json' }

/** 围栏语言 → 高亮语言名（不认识返回 null=纯文本）。必须在调用高亮器前预检：cli-highlight
 *  对未注册语言会先往 stderr 打「Could not find the language …」再 throw——throw 会被
 *  CodeBlock 的 catch 降级，stderr 那行却已经漏进终端（2026-08-29 用户点名）。 */
export function resolveHighlightLang(lang: string | undefined, supports: SupportsLanguageFn): string | null {
  if (lang === undefined || lang === '') return null
  const mapped = LANG_ALIASES[lang] ?? lang
  return supports(mapped) ? mapped : null
}

/** 代码块：cli-highlight 高亮（动态加载）+ 圆角边框；加载中 / 未知语言 fallback 纯文本 */
function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactElement {
  const [ansi, setAnsi] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const out = (v: string): void => {
      if (!cancelled) setAnsi(v)
    }
    loadHighlight()
      .then(({ hl, supports }) => {
        // 高亮前先验语言（resolveHighlightLang 注）——jsonc 等映射别名照常高亮，
        // 不认识的语言直接纯文本，不碰高亮器（stderr 警告不再漏进终端）
        const hlLang = resolveHighlightLang(lang, supports)
        try {
          out(hlLang !== null ? hl(code, { language: hlLang }) : hl(code))
        } catch {
          out(code)
        }
      })
      .catch(() => out(code))
    return () => {
      cancelled = true
    }
  }, [code, lang])

  const spans = ansi !== null ? parseAnsi(ansi) : [{ text: code }]
  // F-42：代码块去边框——用户从终端复制代码时 ╭─│╰ 边框字符会混进剪贴板无法直接使用
  // （dogfood 2026-08-29 用户点名）。区分靠背景色（剪贴板只带走文本）+ 缩进（合法空格）；
  // 顺带每块省 2 行边框行（V 线预算减压）。CC 代码块同为无装饰字符形态。
  return (
    <Box flexDirection="column" backgroundColor={theme.codeBg} paddingLeft={2} paddingRight={1}>
      <Text>
        {spans.map((s, i) => (
          <Text key={i} {...spanProps(s)}>
            {s.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/** 表格列宽分配：短列保底宽（自然宽不超过它的列不参与压缩，表头/路径类短列原样保留） */
const TABLE_MIN_COL_WIDTH = 10

/** cli-table3 单元格默认左右 padding 各 1：colWidths 是含 padding 的整格宽，折行宽才是纯内容宽 */
const TABLE_CELL_PADDING = 2

/**
 * 表格降级阈值：单元格按分配列宽折行后最大行数超过它 → 整表转 key-value 垂直格式。
 * 表格被压得太高（长描述 + 窄终端）时，垂直 key-value 比碎成多行的表格可读（对齐 Claude Code 同款策略）。
 */
const TABLE_MAX_ROW_LINES = 4

/** 最大余数法整数分配：raw（实数和恰为 total）取整后凑齐 total，保证合计不漂移 */
function largestRemainder(raw: number[], total: number): number[] {
  const out = raw.map(Math.floor)
  const rest = total - out.reduce((a, b) => a + b, 0)
  const byRemainder = raw
    .map((v, i) => ({ i, rem: v - Math.floor(v) }))
    .sort((a, b) => b.rem - a.rem)
  for (let k = 0; k < rest; k++) out[byRemainder[k % byRemainder.length].i]++
  return out
}

/**
 * 表格列宽分配：按终端可用宽自适应（cli-table3 只按内容自然宽排布，总宽超屏会被终端
 * 软折行打碎边框——中文长描述列一列就能撑到 100+ 显示宽）。
 * - 自然宽合计 <= budget → 各列自然宽，不折行
 * - 超预算 → 短列（<= TABLE_MIN_COL_WIDTH）保底不压，长列按各自超出保底的部分比例分掉剩余预算
 * - 预算低于列数（终端过窄）→ 均分兜底，每列至少 1
 * 返回值合计恰为 max(budget, 列数)，可直接作 cli-table3 colWidths。
 */
export function computeColWidths(natural: number[], budget: number): number[] {
  if (natural.length === 0) return []
  const clampedBudget = Math.max(budget, natural.length)
  const total = natural.reduce((a, b) => a + b, 0)
  if (total <= clampedBudget) return natural.slice()
  const floors = natural.map((w) => Math.min(Math.max(w, 1), TABLE_MIN_COL_WIDTH))
  const reserved = floors.reduce((a, b) => a + b, 0)
  if (reserved >= clampedBudget) {
    const share = clampedBudget / natural.length
    return largestRemainder(
      natural.map(() => share),
      clampedBudget,
    )
  }
  const surplus = clampedBudget - reserved
  const flexTotal = natural.reduce((a, b, i) => a + Math.max(b - floors[i], 0), 0)
  const raw = floors.map((f, i) => f + (surplus * Math.max(natural[i] - f, 0)) / flexTotal)
  return largestRemainder(raw, clampedBudget)
}

/** 各列自然显示宽（单元格含 \n 时逐行取最大；string-width 剥 ANSI 计中文 2 列，与 cli-table3 测量一致） */
function naturalColWidths(allRows: string[][]): number[] {
  const widths: number[] = []
  for (const row of allRows) {
    row.forEach((cell, i) => {
      const w = Math.max(...cell.split('\n').map((line) => stringWidth(line)))
      widths[i] = Math.max(widths[i] ?? 0, w)
    })
  }
  return widths
}

/** ANSI 字符串 → 纯文本（垂直格式的标签用，表头单元格含行内样式 ANSI） */
function plainText(ansi: string): string {
  return parseAnsi(ansi)
    .map((s) => s.text)
    .join('')
}

/** 单条 key-value：粗体青色标签 + 值悬挂缩进折行（续行对齐值起始列） */
function KVCell({ label, value }: { label: string; value: string }): ReactElement {
  // 单元格内换行/连续空白归一（markdown 单元格里的排版噪声在垂直形态无意义）
  const normalized = value.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  const labelWidth = stringWidth(label)
  // 标签过长（值被挤到 < 10 列）时标签独立成行，值退回 2 空格缩进
  const labelOwnLine = labelWidth > cols() - 12
  const prefixWidth = labelOwnLine ? 2 : labelWidth + 2
  const valueLines = smartWrapAnsi(normalized, Math.max(cols() - prefixWidth, 10)).split('\n')
  const styledLabel = `\u001b[1m\u001b[36m${label}\u001b[39m\u001b[22m`
  const lines = labelOwnLine
    ? [styledLabel, ...valueLines.map((l) => '  ' + l)]
    : valueLines.map((l, i) => (i === 0 ? `${styledLabel}: ${l}` : ' '.repeat(labelWidth + 2) + l))
  const spans = parseAnsi(lines.join('\n'))
  return (
    <Text>
      {spans.map((s, i) => (
        <Text key={i} {...spanProps(s)}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * 表格降级形态：key-value 垂直格式，每条记录按列展开、记录间细分隔线。
 * 值统一按首行宽一步折行（smartWrapAnsi，标签 + ': ' 占前缀），续行缩进对齐值起始列——
 * 不做两段重 wrap（断开的 token 会被重拼进空格，URL 之类被污染）。
 */
function VerticalTableBlock({ head, rows }: { head: string[]; rows: string[][] }): ReactElement {
  const labels = head.map(plainText)
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 && <Text dimColor>{'─'.repeat(Math.min(cols() - 1, 40))}</Text>}
          {row.map((cell, j) => (
            <KVCell key={j} label={labels[j] || `列 ${j + 1}`} value={cell} />
          ))}
        </Fragment>
      ))}
    </Box>
  )
}

/**
 * 表格：cli-table3 画框对齐 + 终端宽自适应。
 * 超屏时自算列宽（computeColWidths）并用 smartWrapAnsi（wrap.ts，语义断点优先）预折行
 * 后再喂 cli-table3——cli-table3 自带的 wordWrap 对中文不安全（按空白分词断不了无空格的
 * 中文长句；hard 模式按 UTF-16 code unit 切，中文 1 字 2 列必超宽），不能开。
 * 折行后行数超 TABLE_MAX_ROW_LINES → 整表降级 key-value 垂直格式。
 */
function TableBlock({ token }: { token: BlockTok }): ReactElement {
  const head = (token.header ?? []).map((h) => inlineToAnsi(h.tokens as unknown as InlineTok[]) || (h.text ?? ''))
  const rows = (token.rows ?? []).map((r) => r.map((c) => inlineToAnsi(c.tokens as unknown as InlineTok[]) || (c.text ?? '')))
  const colCount = head.length
  // 可用内容宽 = 渲染宽 - 边框/内边距开销：每列左右各 1 空格 + 1 竖线，再加最外 1 条竖线
  const budget = Math.max(cols() - (colCount * 3 + 1), colCount)
  const natural = naturalColWidths([head, ...rows])
  const widths = computeColWidths(natural, budget)
  const overflow = natural.reduce((a, b) => a + b, 0) > budget
  const wrapCell = (cell: string, i: number): string => (overflow ? smartWrapAnsi(cell, widths[i]) : cell)
  const wrappedHead = head.map(wrapCell)
  const wrappedRows = rows.map((row) => row.map(wrapCell))
  const maxCellLines = Math.max(1, ...[wrappedHead, ...wrappedRows].flat().map((c) => c.split('\n').length))
  if (maxCellLines > TABLE_MAX_ROW_LINES) return <VerticalTableBlock head={head} rows={rows} />
  const table = new Table({
    head: wrappedHead,
    colWidths: widths.map((w) => w + TABLE_CELL_PADDING),
    style: { head: ['cyan'], border: ['gray'] },
  })
  for (const row of wrappedRows) table.push(row)
  const spans = parseAnsi(table.toString())
  return (
    <Text>
      {spans.map((s, i) => (
        <Text key={i} {...spanProps(s)}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/** 单个 block token → React 节点 */
function renderToken(tok: BlockTok, key: number): ReactNode {
  switch (tok.type) {
    case 'heading': {
      // 标题统一 accent + bold（砍五彩 bright，调研：opencode/aider 单色标题，靠粗体分层）
      const color = '#F5A742'
      return (
        <Box key={key}>
          <Text bold color={color}>
            <AnsiText ansi={inlineToAnsi(tok.tokens as unknown as InlineTok[])} wrap={false} />
          </Text>
        </Box>
      )
    }
    case 'paragraph':
      return (
        <Box key={key}>
          <AnsiText ansi={inlineToAnsi(tok.tokens as unknown as InlineTok[])} wrap={true} />
        </Box>
      )
    case 'code':
      return <CodeBlock key={key} code={tok.text ?? ''} lang={tok.lang} />
    case 'pre':
      return <CodeBlock key={key} code={tok.text ?? ''} />
    case 'hr':
      return (
        <Text key={key} dimColor>
          {'─'.repeat(cols())}
        </Text>
      )
    case 'blockquote': {
      const inner = (tok.tokens ?? []).map((t, i) => renderToken(t, i))
      return (
        <Box key={key} flexDirection="column">
          {inner.map((node, i) => (
            <Box key={i}>
              <Text color="gray">│ </Text>
              {node}
            </Box>
          ))}
        </Box>
      )
    }
    case 'list': {
      const items = tok.items ?? []
      const start = tok.start ?? 1
      return (
        <Box key={key} flexDirection="column">
          {items.map((item, i) => (
            <Box key={i}>
              <Text dimColor>{tok.ordered ? `${start + i}. ` : '• '}</Text>
              <AnsiText ansi={inlineToAnsi(item.tokens as unknown as InlineTok[])} wrap={true} />
            </Box>
          ))}
        </Box>
      )
    }
    case 'space':
      // 排版批②：space token 不再渲染成单个空格（原样混进流里很怪）——
      // 块间距已由外层 Box gap={GAP.block} 统一提供，token 本身零渲染
      return null
    case 'table':
      return <TableBlock key={key} token={tok} />
    case 'html':
      return null
    default:
      return tok.text ? (
        <Box key={key}>
          <AnsiText ansi={tok.text} wrap={true} />
        </Box>
      ) : null
  }
}

/** 解码常见 HTML 实体（LLM 回复常含 &nbsp; 等缩进，终端原样显示会乱） */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Markdown 渲染主组件：给已 commit 的助手消息用 */
export const Markdown = memo(function Markdown({ text }: { text: string }): ReactElement {
  const decoded = decodeHtmlEntities(text)
  // 快速路径：无 markdown 语法 → 纯文本按宽度折行（跳过 lexer）
  if (!hasMarkdownSyntax(decoded)) {
    return <AnsiText ansi={decoded} wrap={true} />
  }
  const tokens = marked.lexer(decoded) as unknown as BlockTok[]
  return (
    <Box flexDirection="column" gap={GAP.block}>
      {tokens.map((tok, i) => renderToken(tok, i))}
    </Box>
  )
})
