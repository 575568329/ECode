import { useState, useEffect } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Text, Box } from 'ink'
import { marked } from 'marked'
import wrapAnsi from 'wrap-ansi'
import Table from 'cli-table3'
import { parseAnsi, type Span } from './ansi.js'
import { hasMarkdownSyntax, inlineToAnsi, type InlineTok } from './mdparse.js'

/**
 * Markdown 渲染组件（M2 阶段一：静态 markdown，给已 commit 的助手消息用）。
 *
 * 架构（借鉴 Claude Code，简化）：
 *   marked.lexer → block tokens → 按 type 映射 Ink 原语
 *   inline tokens → inlineToAnsi（ANSI 字符串）→ wrap-ansi（中文按显示宽度折行）→ parseAnsi → <Text> spans
 *   代码块 → cli-highlight（动态懒加载，TTY 下着色）→ parseAnsi → <Box borderStyle="round">
 *   表格 → cli-table3（CJK 安全）→ parseAnsi → <Text>
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

/** 渲染列宽：终端更窄取终端宽，上限 100 避免过宽难读 */
function cols(): number {
  return Math.min(process.stdout.columns || 80, 100)
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
let hlPromise: Promise<HighlightFn> | null = null
function loadHighlight(): Promise<HighlightFn> {
  if (!hlPromise) {
    hlPromise = import('cli-highlight').then((m) => {
      const fn = m.highlight ?? (m.default as { highlight?: HighlightFn } | undefined)?.highlight
      if (typeof fn !== 'function') throw new Error('cli-highlight.highlight not found')
      return fn
    })
  }
  return hlPromise
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
      .then((hl) => {
        try {
          out(lang ? hl(code, { language: lang }) : hl(code))
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingLeft={1} paddingRight={1}>
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

/** 表格：cli-table3（CJK 安全，内置 string-width 列宽对齐） */
function TableBlock({ token }: { token: BlockTok }): ReactElement {
  const head = (token.header ?? []).map((h) => h.text ?? '')
  const rows = (token.rows ?? []).map((r) => r.map((c) => c.text ?? ''))
  const table = new Table({ head, style: { head: ['cyan'], border: ['gray'] } })
  for (const row of rows) table.push(row)
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
      const palette = ['magentaBright', 'cyanBright', 'greenBright', 'yellowBright', 'blueBright', 'magenta']
      const color = palette[((tok.depth ?? 1) - 1) % palette.length]
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
      return <Text key={key}> </Text>
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

/** Markdown 渲染主组件：给已 commit 的助手消息用 */
export function Markdown({ text }: { text: string }): ReactElement {
  // 快速路径：无 markdown 语法 → 纯文本按宽度折行（跳过 lexer）
  if (!hasMarkdownSyntax(text)) {
    return <AnsiText ansi={text} wrap={true} />
  }
  const tokens = marked.lexer(text) as unknown as BlockTok[]
  return (
    <Box flexDirection="column">
      {tokens.map((tok, i) => renderToken(tok, i))}
    </Box>
  )
}
