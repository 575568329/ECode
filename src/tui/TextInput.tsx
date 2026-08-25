import type { ReactElement } from 'react'
import { useInput, Text, Box } from 'ink'
import {
  insert,
  backspace,
  deleteRight,
  moveLeft,
  moveRight,
  moveHome,
  moveEnd,
  splitAtCaret,
  countGraphemes,
  type CursorState,
} from './cursor.js'
import { symbols } from './symbols.js'
import { theme } from './theme.js'

interface InputRenderProps {
  text: string
  caret: number
  placeholder?: string
}

/** 输入框可见行数上限：超过即折叠为指示行（M14 §3.2「输入粘贴」项先行——动态区防超屏） */
const INPUT_FOLD_MAX_LINES = 5

/** 折叠视图的一行：文本行 or 折叠指示（count = 被折叠行数） */
export interface FoldRow {
  kind: 'text' | 'folded'
  text: string
  count: number
}

/** caret（全文字素下标）→ 行号 + 行内字素列（\n 计 1 字素） */
function caretLineCol(lines: string[], caret: number): { line: number; col: number } {
  let consumed = 0
  for (let i = 0; i < lines.length; i++) {
    const len = countGraphemes(lines[i] as string)
    if (caret <= consumed + len) return { line: i, col: caret - consumed }
    consumed += len + 1
  }
  const last = lines.length - 1
  return { line: last, col: countGraphemes(lines[last] ?? '') }
}

/**
 * 输入框折叠视图：≤ maxLines 原样；超过则显示头部 maxLines 行（看内容是什么——头窗偏置，
 * 用户拍板；CC「+N lines pasted」同形态）+ 底部折叠指示。caret 在折叠区时额外亮出
 * caret 所在行（粘贴后 caret 在末尾，不亮出来打字不可见）。纯显示折叠，提交不受影响。
 */
export function foldInputView(text: string, caret: number, maxLines = INPUT_FOLD_MAX_LINES): { rows: FoldRow[]; caretRow: number; caretCol: number } {
  const lines = text.split('\n')
  const { line: cl, col: caretCol } = caretLineCol(lines, caret)
  if (lines.length <= maxLines) {
    return { rows: lines.map((t) => ({ kind: 'text' as const, text: t, count: 0 })), caretRow: cl, caretCol }
  }
  const rows: FoldRow[] = lines.slice(0, maxLines).map((t) => ({ kind: 'text' as const, text: t, count: 0 }))
  if (cl < maxLines) {
    // caret 在头部窗内：剩余尾部整体折叠
    rows.push({ kind: 'folded', text: '', count: lines.length - maxLines })
    return { rows, caretRow: cl, caretCol }
  }
  // caret 在折叠区：头部窗 + 上侧折叠指示 + caret 行 + 下侧折叠指示
  const above = cl - maxLines
  if (above > 0) rows.push({ kind: 'folded', text: '', count: above })
  rows.push({ kind: 'text', text: lines[cl] as string, count: 0 })
  const below = lines.length - 1 - cl
  if (below > 0) rows.push({ kind: 'folded', text: '', count: below })
  return { rows, caretRow: rows.length - (below > 0 ? 2 : 1), caretCol }
}

/** 输入渲染：❯ + 反色 caret 字素（设计理念 §7.2：反色不塞 ▋，跨字素不错位） */
export function InputRender({ text, caret, placeholder }: InputRenderProps): ReactElement {
  const folded = text.split('\n').length > INPUT_FOLD_MAX_LINES
  return (
    <Box>
      <Text color={theme.user}>{symbols.prompt}</Text>
      <Text> </Text>
      {text === '' && placeholder !== undefined ? (
        <Text dimColor>{placeholder}</Text>
      ) : folded ? (
        <FoldedCaretText text={text} caret={caret} />
      ) : (
        <CaretText text={text} caret={caret} />
      )}
    </Box>
  )
}

/** 折叠态输入：可见窗内 caret 行反色，折叠段用指示行替代（CC「+N lines」同款形态） */
function FoldedCaretText({ text, caret }: { text: string; caret: number }): ReactElement {
  const total = text.split('\n').length
  const view = foldInputView(text, caret)
  return (
    <Box flexDirection="column">
      {view.rows.map((row, i) =>
        row.kind === 'folded' ? (
          <Text key={i} dimColor>{`…已折叠 ${row.count} 行（共 ${total} 行）`}</Text>
        ) : i === view.caretRow ? (
          <CaretText key={i} text={row.text} caret={view.caretCol} />
        ) : (
          <Text key={i}>{row.text === '' ? ' ' : row.text}</Text>
        ),
      )}
    </Box>
  )
}

function CaretText({ text, caret }: { text: string; caret: number }): ReactElement {
  const { before, at, after } = splitAtCaret(text, caret)
  return (
    <Text>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </Text>
  )
}

interface TextInputProps {
  value: string
  caret: number
  placeholder?: string
  onInput?: (next: CursorState) => void
  onSubmit?: (text: string) => void
  /** 禁用按键（覆盖层显示时，避免按键漏进输入框） */
  inactive?: boolean
}

/**
 * 自建 TextInput（设计理念 §7.1-7.3，受控版）：
 * - Cursor 字素编辑模型（不可变，已单测）
 * - 反色 caret（跨字素不错位，中文/emoji 友好）
 * - useInput 接键：字符 / Backspace / Delete / ← / → / Home / End / Enter
 * - value/caret 由父控制（InputStream 管 history / 补全）；停泊原生光标留后续
 */
export function TextInput({ value, caret, placeholder, onInput, onSubmit, inactive }: TextInputProps): ReactElement {
  const cur: CursorState = { text: value, caret }
  useInput((input, key) => {
    if (key.return) {
      onSubmit?.(value)
      return
    }
    if (key.backspace) {
      onInput?.(backspace(cur))
      return
    }
    if (key.delete) {
      onInput?.(deleteRight(cur))
      return
    }
    if (key.leftArrow) {
      onInput?.(moveLeft(cur))
      return
    }
    if (key.rightArrow) {
      onInput?.(moveRight(cur))
      return
    }
    if (key.home) {
      onInput?.(moveHome(cur))
      return
    }
    if (key.end) {
      onInput?.(moveEnd(cur))
      return
    }
    if (!key.ctrl && !key.meta && !key.escape && input !== '') {
      // 行尾归一：xterm.js 系终端（VS Code / ZCode 集成终端）粘贴把换行统一转成裸 \r——
      // 原样进渲染层会被终端当「回到行首」逐段覆盖，视觉上只剩最后一行（数据完整、显示被骗）
      onInput?.(insert(cur, input.replace(/\r\n?/g, '\n')))
    }
  }, { isActive: !inactive })
  return <InputRender text={value} caret={caret} placeholder={placeholder} />
}
