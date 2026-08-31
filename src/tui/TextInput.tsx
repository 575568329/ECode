import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { useInput, Text, Box } from 'ink'
import wrapAnsi from 'wrap-ansi'
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
  graphemes,
  type CursorState,
} from './cursor.js'
import { symbols } from './symbols.js'
import { theme } from './theme.js'
import { INDENT } from './layout.js'
import { useViewport } from './viewport.js'

interface InputRenderProps {
  text: string
  caret: number
  placeholder?: string
  /** 查看窗锚（输入体验批）：定义且内容折叠时窗口锚定此物理行（PgUp/PgDn 驱动） */
  viewAnchor?: number
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

/** 单逻辑行 wrap 成物理行（与 viewport.foldLines 同参：hard 断长 token、保留缩进） */
function physicalLines(line: string, width: number): string[] {
  if (line === '') return ['']
  return wrapAnsi(line, width, { hard: true, trim: false }).split('\n')
}

/** 物理行总数（M14-V2：折叠判定与指示行计数用物理行——超长单行也计入） */
export function physicalLineCount(text: string, width: number): number {
  if (!(Number.isFinite(width) && width >= 1)) return text.split('\n').length
  let n = 0
  for (const line of text.split('\n')) n += physicalLines(line, width).length
  return n
}

/**
 * 输入框折叠视图：≤ maxLines 原样；超过则显示头部 maxLines 行（看内容是什么——头窗偏置，
 * 用户拍板；CC「+N lines pasted」同形态）+ 底部折叠指示。caret 在折叠区时额外亮出
 * caret 所在行（粘贴后 caret 在末尾，不亮出来打字不可见）。纯显示折叠，提交不受影响。
 *
 * M14-V2：width 提供时按**物理行**折叠（超长单行 wrap 后计入窗口；caret 映射到
 * 物理行 + 显示列）；无 width 保持逻辑行旧行为（无视口上下文调用方/测试）。
 *
 * 输入体验批（2026-08-31）：anchor 提供且内容折叠时进入**查看窗**——窗口锚定 anchor
 * （clamp 到 [0, total-maxLines]），caret 不在窗内时 caretRow=-1（纯查看态，caret 暂时
 * 不可见）；PgUp/PgDn 驱动（TextInput），任意编辑经 anchor 重置回吸。
 */
export function foldInputView(
  text: string,
  caret: number,
  maxLines = INPUT_FOLD_MAX_LINES,
  width?: number,
  anchor?: number,
): { rows: FoldRow[]; caretRow: number; caretCol: number; totalPhysical: number } {
  if (width === undefined || !Number.isFinite(width) || width < 1) {
    const lines = text.split('\n')
    const { line: cl, col: caretCol } = caretLineCol(lines, caret)
    if (lines.length <= maxLines) {
      return { rows: lines.map((t) => ({ kind: 'text' as const, text: t, count: 0 })), caretRow: cl, caretCol, totalPhysical: lines.length }
    }
    // 查看窗：锚定偏置（逻辑行路径——无视口调用方/测试）
    if (anchor !== undefined) {
      const start = Math.min(Math.max(0, anchor), lines.length - maxLines)
      const rows: FoldRow[] = []
      if (start > 0) rows.push({ kind: 'folded', text: '', count: start })
      for (let i = start; i < start + maxLines; i++) rows.push({ kind: 'text', text: lines[i] ?? '', count: 0 })
      const below = lines.length - (start + maxLines)
      if (below > 0) rows.push({ kind: 'folded', text: '', count: below })
      const caretRow = cl >= start && cl < start + maxLines ? cl - start + (start > 0 ? 1 : 0) : -1
      return { rows, caretRow, caretCol: caretRow >= 0 ? caretCol : 0, totalPhysical: lines.length }
    }
    const rows: FoldRow[] = lines.slice(0, maxLines).map((t) => ({ kind: 'text' as const, text: t, count: 0 }))
    if (cl < maxLines) {
      // caret 在头部窗内：剩余尾部整体折叠
      rows.push({ kind: 'folded', text: '', count: lines.length - maxLines })
      return { rows, caretRow: cl, caretCol, totalPhysical: lines.length }
    }
    // caret 在折叠区：头部窗 + 上侧折叠指示 + caret 行 + 下侧折叠指示
    const above = cl - maxLines
    if (above > 0) rows.push({ kind: 'folded', text: '', count: above })
    rows.push({ kind: 'text', text: lines[cl] as string, count: 0 })
    const below = lines.length - 1 - cl
    if (below > 0) rows.push({ kind: 'folded', text: '', count: below })
    return { rows, caretRow: rows.length - (below > 0 ? 2 : 1), caretCol, totalPhysical: lines.length }
  }
  // 物理行路径：每逻辑行 wrap → caret 定位物理行 + 显示列（stringWidth）
  const logical = text.split('\n')
  const physPerLine = logical.map((l) => physicalLines(l, width))
  const totalPhysical = physPerLine.reduce((n, p) => n + p.length, 0)
  const { line: cl, col: charCol } = caretLineCol(logical, caret)
  let physIdx = 0
  let physStart = 0
  for (let i = 0; i < (physPerLine[cl] ?? []).length; i++) {
    const len = countGraphemes((physPerLine[cl] as string[])[i] as string)
    if (charCol <= physStart + len) {
      physIdx = i
      break
    }
    physIdx = i
    physStart += len
  }
  const physText = physPerLine[cl]?.[physIdx] ?? ''
  // 审阅 P1-9：caretCol 是字素索引（CaretText/splitAtCaret 口径）非显示列——原 stringWidth
  // +UTF-16 slice 双重口径错位（'中中abc' caret 在 a 前反色落在 c）；按字素切取前缀
  const caretCol = graphemes(physText).slice(0, Math.max(0, charCol - physStart)).length
  const caretGlobalPhys = physPerLine.slice(0, cl).reduce((n, p) => n + p.length, 0) + physIdx
  const flat: string[] = []
  physPerLine.forEach((p) => flat.push(...p))
  if (totalPhysical <= maxLines) {
    return { rows: flat.map((t) => ({ kind: 'text' as const, text: t, count: 0 })), caretRow: caretGlobalPhys, caretCol, totalPhysical }
  }
  // 查看窗：锚定偏置（物理行路径）
  if (anchor !== undefined) {
    const start = Math.min(Math.max(0, anchor), totalPhysical - maxLines)
    const rows: FoldRow[] = []
    if (start > 0) rows.push({ kind: 'folded', text: '', count: start })
    for (let i = start; i < start + maxLines; i++) rows.push({ kind: 'text', text: flat[i] ?? '', count: 0 })
    const below = totalPhysical - (start + maxLines)
    if (below > 0) rows.push({ kind: 'folded', text: '', count: below })
    const caretRow =
      caretGlobalPhys >= start && caretGlobalPhys < start + maxLines ? caretGlobalPhys - start + (start > 0 ? 1 : 0) : -1
    return { rows, caretRow, caretCol: caretRow >= 0 ? caretCol : 0, totalPhysical }
  }
  const rows: FoldRow[] = flat.slice(0, maxLines).map((t) => ({ kind: 'text' as const, text: t, count: 0 }))
  if (caretGlobalPhys < maxLines) {
    rows.push({ kind: 'folded', text: '', count: totalPhysical - maxLines })
    return { rows, caretRow: caretGlobalPhys, caretCol, totalPhysical }
  }
  const above = caretGlobalPhys - maxLines
  if (above > 0) rows.push({ kind: 'folded', text: '', count: above })
  rows.push({ kind: 'text', text: physText, count: 0 })
  const below = totalPhysical - 1 - caretGlobalPhys
  if (below > 0) rows.push({ kind: 'folded', text: '', count: below })
  return { rows, caretRow: rows.length - (below > 0 ? 2 : 1), caretCol, totalPhysical }
}

/** 输入渲染：F-36 栅格同款（2026-08-29 用户拍板：第一列 ❯ 图标槽、内容列从第 2 列起、
 *  折行/折叠行不占第 1 列——与对话区用户消息/助手消息同一栅格语言）+ 反色 caret 字素
 *  （设计理念 §7.2：反色不塞 ▋，跨字素不错位） */
export function InputRender({ text, caret, placeholder, viewAnchor }: InputRenderProps): ReactElement {
  const { columns } = useViewport()
  const width = columns - 2 // ❯ 前缀槽占 2 列
  const folded = physicalLineCount(text, width) > INPUT_FOLD_MAX_LINES
  return (
    <Box flexDirection="row">
      <Box minWidth={INDENT.icon} flexShrink={0}>
        <Text color={theme.user}>{symbols.prompt}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        {text === '' && placeholder !== undefined ? (
          <Text dimColor>{placeholder}</Text>
        ) : folded ? (
          <FoldedCaretText text={text} caret={caret} width={width} anchor={viewAnchor} />
        ) : (
          <CaretText text={text} caret={caret} />
        )}
      </Box>
    </Box>
  )
}

/** 折叠态输入：可见窗内 caret 行反色，折叠段用指示行替代（CC「+N lines」同款形态）。
 *  输入体验批：anchor 定义时进入查看窗（PgUp/PgDn 滚看），底部指示行带查看键提示 */
function FoldedCaretText({ text, caret, width, anchor }: { text: string; caret: number; width: number; anchor?: number }): ReactElement {
  const view = foldInputView(text, caret, INPUT_FOLD_MAX_LINES, width, anchor)
  const lastIdx = view.rows.length - 1
  return (
    <Box flexDirection="column">
      {view.rows.map((row, i) =>
        row.kind === 'folded' ? (
          <Text key={i} dimColor>
            {`…已折叠 ${row.count} 行（共 ${view.totalPhysical} 行）${i === lastIdx ? '· PgUp/PgDn 查看' : ''}`}
          </Text>
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
  const { columns } = useViewport()
  const viewWidth = columns - 2
  // 输入体验批：查看窗锚（物理行）——PgUp/PgDn 滚看折叠草稿的中后段；value/caret 任意变化
  // （键入/粘贴/回填/清空）即重置回吸 caret。滚轮不做：主屏未开鼠标跟踪（SGR 仅 alt-screen
  // OutputViewer 开启），终端滚轮归原生 scrollback——挂账
  const [viewAnchor, setViewAnchor] = useState<number | null>(null)
  useEffect(() => {
    setViewAnchor(null)
  }, [value, caret])
  const folded = physicalLineCount(value, viewWidth) > INPUT_FOLD_MAX_LINES
  useInput((input, key) => {
    // 查看窗滚动（输入体验批）：PgUp/PgDn 滚看折叠草稿——平铺态无窗可滚（不消费，透传）
    if (key.pageUp || key.pageDown) {
      if (!folded || inactive) return
      setViewAnchor((a) => {
        const base = a ?? 0
        return Math.max(0, base + (key.pageUp ? -INPUT_FOLD_MAX_LINES : INPUT_FOLD_MAX_LINES))
      })
      return
    }
    // 手动换行三键位（legacy 终端 Shift+Enter 与 Enter 同字节 \r 不可区分——跨端稳妥组合）：
    // - Shift+Enter / Alt+Enter：kitty 协议或 ESC \r 序列可区分修饰键
    // - Ctrl+J：裸 \n（parse-keypress 归 name='enter'，input='\n'）或 kitty 形态 ctrl+'j'
    if ((key.return && (key.shift || key.meta)) || (!key.return && input === '\n') || (key.ctrl && input === 'j')) {
      onInput?.(insert(cur, '\n'))
      return
    }
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
  return <InputRender text={value} caret={caret} placeholder={placeholder} viewAnchor={viewAnchor ?? undefined} />
}
