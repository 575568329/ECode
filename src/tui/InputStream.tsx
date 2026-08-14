import { useState, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useInput, Text, Box } from 'ink'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { commandRegistry, type Command, type CommandResult } from '../commands/registry.js'
import { skillRegistry } from '../services/skill.js'

/** / 补全条目：内置命令 + skill 合并（S4.4；命令在前=内置优先分流）。 */
export interface SlashEntry {
  kind: 'cmd' | 'skill'
  name: string
  description: string
  /** 与内置命令撞名的 skill（加载时检测，S4.1） */
  shadowed?: boolean
}

/**
 * 合并匹配（S4.4）：prefix 不含空格才匹配（输入第一个空格后停止命令名匹配，后续是参数）。
 * 命令在前、skill 在后；skill 侧过滤 user-invocable:false（手动面不可见）。
 */
export function matchSlashEntries(prefix: string): SlashEntry[] {
  if (prefix.includes(' ')) return []
  const cmds: SlashEntry[] = commandRegistry
    .match(prefix)
    .map((c) => ({ kind: 'cmd' as const, name: c.name, description: c.description }))
  const skills: SlashEntry[] = skillRegistry
    .listForCompletion()
    .filter((s) => s.name.startsWith(prefix))
    .map((s) => ({
      kind: 'skill' as const,
      name: s.name,
      description: s.description,
      shadowed: skillRegistry.shadowedByCommand.has(s.name),
    }))
  return [...cmds, ...skills]
}

/** / 斜杠补全：列表展示 + 上下选中高亮（selectedIdx）；skill 条目标来源。 */
export function SlashSuggest({
  text,
  selectedIdx = -1,
}: {
  text: string
  selectedIdx?: number
}): ReactElement | null {
  if (!text.startsWith('/')) return null
  const matches = matchSlashEntries(text.slice(1))
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {matches.map((c, i) => (
        <Text key={c.kind + c.name} inverse={i === selectedIdx}>
          /{c.name} <Text dimColor>{c.description}</Text>
          {c.kind === 'skill' ? <Text color="cyan"> (skill)</Text> : null}
          {c.shadowed ? <Text color="yellow"> (被命令遮蔽)</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

interface InputStreamProps {
  onSubmit: (text: string) => void
  onCommand?: (cmd: Command, result: CommandResult) => void
  /** 手动触发 skill（S4.4 分流：命令→skill→未知；展开注入由 TuiApp 做） */
  onSkillInvoke?: (name: string, args?: string) => void
  onClear?: () => void
  placeholder?: string
  /** 禁用按键（覆盖层显示时，方向键/字符不漏进历史导航与输入框） */
  inactive?: boolean
  /** 受控插入（面板回填通道，S-P6）：seq 变化时把 text 写入输入框（如 `/skillname `） */
  insert?: { text: string; seq: number }
}

/**
 * 输入流：TextInput + 历史（↑↓）+ / 补全（↑↓ 选中 + Enter 执行选中 + Tab 补全）。
 * - slash 模式 + 选中 + Enter → 直接执行选中命令/skill（不需先 Tab 补全）
 * - slash 模式 + 未选中 + Enter → submit 当前文本（如 /xyz → 未知命令）
 * - `/name args...` → 命令带参 run(args)；无命令命中查 skill（userInvocable）→ onSkillInvoke
 */
export function InputStream({
  onSubmit,
  onCommand,
  onSkillInvoke,
  onClear,
  placeholder,
  inactive,
  insert,
}: InputStreamProps): ReactElement {
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [slashIdx, setSlashIdx] = useState(-1)
  const lastInsertSeq = useRef(-1)

  // cur.text 变化时重置 slashIdx：有匹配默认选中第一个（UI 高亮 + 回车执行第一个），
  // 无匹配 -1（不显示建议列表）
  useEffect(() => {
    const matches = cur.text.startsWith('/') ? matchSlashEntries(cur.text.slice(1)) : []
    setSlashIdx(matches.length > 0 ? 0 : -1)
  }, [cur.text])

  // 面板回填通道：seq 变化 → 写入输入框（幂等，同 seq 不重写）
  useEffect(() => {
    if (insert === undefined || insert.seq === lastInsertSeq.current) return
    lastInsertSeq.current = insert.seq
    setCur(createCursor(insert.text))
    setHistIdx(-1)
  }, [insert])

  const submit = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    if (trimmed.startsWith('/')) {
      const sp = trimmed.indexOf(' ')
      const name = sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)
      const args = sp === -1 ? undefined : trimmed.slice(sp + 1).trim()
      const cmd = commandRegistry.get(name)
      if (cmd) {
        const result = cmd.run(args)
        if (result.action === 'clear') onClear?.()
        onCommand?.(cmd, result)
      } else {
        // skill 分流（S4.4）：userInvocable 才可手动触发
        const skill = skillRegistry.get(name)
        if (skill !== undefined && skill.userInvocable) {
          onSkillInvoke?.(name, args)
        } else if (skill !== undefined && !skill.userInvocable) {
          onCommand?.({ name, description: '' } as Command, {
            output: `skill「${name}」仅限模型调用，请直接描述任务让 ECode 使用它`,
          })
        } else {
          onCommand?.({ name, description: '' } as Command, { output: `未知命令: /${name}` })
        }
      }
    } else {
      onSubmit(trimmed)
      setHistory((h) => [...h, trimmed])
    }
    setCur(createCursor(''))
    setHistIdx(-1)
  }

  // Enter：slash 模式无参数 + 有匹配 → 执行选中（↑↓）或默认第一个；
  // 有参数（含空格）→ submit 全文走分流（命令带参 / skill 传参）
  const handleTextSubmit = (text: string): void => {
    if (text.startsWith('/') && !/\s/.test(text.trim())) {
      const matches = matchSlashEntries(text.slice(1))
      if (matches.length > 0) {
        const idx = slashIdx >= 0 && slashIdx < matches.length ? slashIdx : 0
        submit(`/${matches[idx].name}`)
        return
      }
    }
    submit(text)
  }

  useInput((_input, key) => {
    const slashMode = cur.text.startsWith('/')
    if (slashMode) {
      const matches = matchSlashEntries(cur.text.slice(1))
      if (key.upArrow && matches.length > 0) {
        setSlashIdx((i) => (i <= 0 ? matches.length - 1 : i - 1))
      } else if (key.downArrow && matches.length > 0) {
        setSlashIdx((i) => (i >= matches.length - 1 ? 0 : i + 1))
      } else if (key.tab && slashIdx >= 0 && matches[slashIdx]) {
        // Tab 补全带尾随空格（提示可接参数；空格后停止命令名匹配）
        setCur(createCursor(`/${matches[slashIdx].name} `))
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
  }, { isActive: !inactive })

  return (
    <Box flexDirection="column">
      <TextInput
        value={cur.text}
        caret={cur.caret}
        placeholder={placeholder}
        onInput={setCur}
        onSubmit={handleTextSubmit}
        inactive={inactive}
      />
      <SlashSuggest text={cur.text} selectedIdx={slashIdx} />
    </Box>
  )
}
