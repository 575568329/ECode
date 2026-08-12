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
  type CursorState,
} from './cursor.js'
import { symbols } from './symbols.js'
import { theme } from './theme.js'

interface InputRenderProps {
  text: string
  caret: number
  placeholder?: string
}

/** 输入渲染：❯ + 反色 caret 字素（设计理念 §7.2：反色不塞 ▋，跨字素不错位） */
export function InputRender({ text, caret, placeholder }: InputRenderProps): ReactElement {
  return (
    <Box>
      <Text color={theme.user}>{symbols.prompt}</Text>
      <Text> </Text>
      {text === '' && placeholder !== undefined ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <CaretText text={text} caret={caret} />
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
}

/**
 * 自建 TextInput（设计理念 §7.1-7.3，受控版）：
 * - Cursor 字素编辑模型（不可变，已单测）
 * - 反色 caret（跨字素不错位，中文/emoji 友好）
 * - useInput 接键：字符 / Backspace / Delete / ← / → / Home / End / Enter
 * - value/caret 由父控制（InputStream 管 history / 补全）；停泊原生光标留后续
 */
export function TextInput({ value, caret, placeholder, onInput, onSubmit }: TextInputProps): ReactElement {
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
      onInput?.(insert(cur, input))
    }
  })
  return <InputRender text={value} caret={caret} placeholder={placeholder} />
}
