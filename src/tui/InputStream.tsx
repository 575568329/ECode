import { useState, useEffect } from 'react'
import type { ReactElement } from 'react'
import { useInput, Text, Box } from 'ink'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { commandRegistry, type Command, type CommandResult } from '../commands/registry.js'

/** / 斜杠补全：列表展示 + 上下选中高亮（selectedIdx）。 */
export function SlashSuggest({
  text,
  selectedIdx = -1,
}: {
  text: string
  selectedIdx?: number
}): ReactElement | null {
  if (!text.startsWith('/')) return null
  const matches = commandRegistry.match(text.slice(1))
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {matches.map((c, i) => (
        <Text key={c.name} inverse={i === selectedIdx}>
          /{c.name} <Text dimColor>{c.description}</Text>
        </Text>
      ))}
    </Box>
  )
}

interface InputStreamProps {
  onSubmit: (text: string) => void
  onCommand?: (cmd: Command, result: CommandResult) => void
  onClear?: () => void
  placeholder?: string
}

/**
 * 输入流：TextInput + 历史（↑↓）+ / 补全（↑↓ 选中 + Enter 执行选中 + Tab 补全）。
 * - slash 模式 + 选中 + Enter → 直接执行选中命令（不需先 Tab 补全）
 * - slash 模式 + 未选中 + Enter → submit 当前文本（如 /xyz → 未知命令）
 */
export function InputStream({ onSubmit, onCommand, onClear, placeholder }: InputStreamProps): ReactElement {
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [slashIdx, setSlashIdx] = useState(-1)

  // cur.text 变化时重置 slashIdx（重新匹配）
  useEffect(() => {
    setSlashIdx(-1)
  }, [cur.text])

  const submit = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    if (trimmed.startsWith('/')) {
      const name = trimmed.slice(1).split(/\s/)[0]
      const cmd = commandRegistry.get(name)
      if (cmd) {
        const result = cmd.run()
        if (result.action === 'clear') onClear?.()
        onCommand?.(cmd, result)
      } else {
        onCommand?.({ name, description: '' } as Command, { output: `未知命令: /${name}` })
      }
    } else {
      onSubmit(trimmed)
      setHistory((h) => [...h, trimmed])
    }
    setCur(createCursor(''))
    setHistIdx(-1)
  }

  // Enter：slash 模式 + 选中 → 执行选中命令；否则 submit 文本
  const handleTextSubmit = (text: string): void => {
    if (text.startsWith('/') && slashIdx >= 0) {
      const matches = commandRegistry.match(text.slice(1))
      if (matches[slashIdx]) {
        submit(`/${matches[slashIdx].name}`)
        return
      }
    }
    submit(text)
  }

  useInput((_input, key) => {
    const slashMode = cur.text.startsWith('/')
    if (slashMode) {
      const matches = commandRegistry.match(cur.text.slice(1))
      if (key.upArrow && matches.length > 0) {
        setSlashIdx((i) => (i <= 0 ? matches.length - 1 : i - 1))
      } else if (key.downArrow && matches.length > 0) {
        setSlashIdx((i) => (i >= matches.length - 1 ? 0 : i + 1))
      } else if (key.tab && slashIdx >= 0 && matches[slashIdx]) {
        setCur(createCursor(`/${matches[slashIdx].name}`))
      }
      return
    }
    // 历史（非 slash 模式）
    if (key.upArrow && history.length > 0) {
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(idx)
      setCur(createCursor(history[idx]))
    } else if (key.downArrow && histIdx >= 0) {
      const idx = histIdx + 1
      if (idx >= history.length) {
        setHistIdx(-1)
        setCur(createCursor(''))
      } else {
        setHistIdx(idx)
        setCur(createCursor(history[idx]))
      }
    }
  })

  return (
    <Box flexDirection="column">
      <TextInput
        value={cur.text}
        caret={cur.caret}
        placeholder={placeholder}
        onInput={setCur}
        onSubmit={handleTextSubmit}
      />
      <SlashSuggest text={cur.text} selectedIdx={slashIdx} />
    </Box>
  )
}
