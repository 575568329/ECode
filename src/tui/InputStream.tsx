import { useState } from 'react'
import type { ReactElement } from 'react'
import { useInput, Text, Box } from 'ink'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { commandRegistry, type Command, type CommandResult } from '../commands/registry.js'

/**
 * / 斜杠补全提示：给定当前输入文本，渲染匹配的命令名（纯展示，可单测）。
 */
export function SlashSuggest({ text }: { text: string }): ReactElement | null {
  if (!text.startsWith('/') || text.length <= 1) return null
  const matches = commandRegistry.match(text.slice(1))
  if (matches.length === 0) return null
  return <Text dimColor>  {matches.map((c) => `/${c.name}`).join('  ')}</Text>
}

interface InputStreamProps {
  /** 普通消息提交（非 / 开头） */
  onSubmit: (text: string) => void
  /** 命令执行结果回调（App 决定怎么显示 output） */
  onCommand?: (cmd: Command, result: CommandResult) => void
  /** /clear 副作用 */
  onClear?: () => void
  placeholder?: string
}

/**
 * 输入流（M2 第 4 步）：TextInput + 历史（↑↓）+ / 补全 + submit 路由（命令 vs 消息）。
 *
 * - 命令（/ 开头）：commandRegistry 查找 → run → onCommand 回传结果（/clear 触发 onClear）
 * - 消息：onSubmit + 入历史
 * - 历史：仅输入框空时 ↑↓ 浏览（避免和 ←→ 编辑冲突）
 * - / 补全：SlashSuggest 显示匹配命令
 */
export function InputStream({ onSubmit, onCommand, onClear, placeholder }: InputStreamProps): ReactElement {
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)

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

  // 历史浏览（仅输入框空时 ↑↓ 触发，不和 ←→ 编辑冲突）
  useInput((_input, key) => {
    if (cur.text !== '') return
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
        onSubmit={submit}
      />
      <SlashSuggest text={cur.text} />
    </Box>
  )
}
