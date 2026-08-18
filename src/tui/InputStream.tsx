import { useState, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useInput, Text, Box } from 'ink'
import { TextInput } from './TextInput.js'
import { createCursor, insert as insertAtCursor, type CursorState } from './cursor.js'
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
/** 补全列表窗口高度（M8：防长清单顶飞输入区——窗口化 + 总数提示让用户知道还有更多） */
const SUGGEST_MAX_ROWS = 6

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
  // 窗口化：选中项保持在窗口内（跟随滚动）；未选中态显示前 6 条
  const start = selectedIdx >= SUGGEST_MAX_ROWS ? Math.min(selectedIdx - SUGGEST_MAX_ROWS + 1, matches.length - SUGGEST_MAX_ROWS) : 0
  const visible = matches.slice(start, start + SUGGEST_MAX_ROWS)
  const hidden = Math.max(0, matches.length - (start + SUGGEST_MAX_ROWS)) // 只数窗口下方（滚到底时 0——审阅 P1-1）
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {start > 0 && <Text dimColor> ↑ 还有 {start} 条（共 {matches.length} 项 · ↑↓ 浏览）</Text>}
      {visible.map((c) => {
        const i = matches.indexOf(c)
        return (
          <Text key={c.kind + c.name} inverse={i === selectedIdx}>
            /{c.name} <Text dimColor>{c.description}</Text>
            {c.kind === 'skill' ? <Text color="cyan"> (skill)</Text> : null}
            {c.shadowed ? <Text color="yellow"> (被命令遮蔽)</Text> : null}
          </Text>
        )
      })}
      {hidden > 0 && <Text dimColor> ↓ 还有 {hidden} 条（共 {matches.length} 项 · ↑↓ 浏览）</Text>}
      <Text dimColor> ↑↓ 选择 · 回车 填入（再回车执行）</Text>
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
  /** M9-P4/D13：Tab 专职沙箱模式循环（主输入空闲态；slash 补全态不拦截） */
  onTabSandbox?: () => void
  /** M10-P2b：Alt+V 粘贴剪贴板图片（图片数据不走 stdin，须专用键位主动读系统剪贴板）。
   * 返回插入输入框的短标签（[图片#N]，无图 null）——标签即引用，删标签=删图（两家同款内嵌形态） */
  onPasteImage?: () => Promise<string | null>
  /** M11-P7：Ctrl+U 清空插话队列（readline 清行习惯键位；防「排了又后悔」） */
  onInterjectClear?: () => void
  /** M11 审阅 P0-1：忙碌态（斜杠拦截必须在 InputStream 分流点——TuiApp.submit 里的守卫不可达，
   * 因为本组件的 submit() 对 / 前缀文本直接走命令分流，不经 onSubmit） */
  busy?: boolean
  /** 忙碌态收到斜杠命令时的宿主提示回调（不执行不排队） */
  onSlashBusy?: () => void
}

/**
 * 输入流：TextInput + 历史（↑↓）+ / 补全（↑↓ 选中 + 回车两段式回填；Tab 已专职沙箱模式）。
 * - 统一两段式（与 SkillPanel 一致，用户拍板）：回车 = 回填 `/选中名 `（尾随空格留参数位），
 *   不直接执行；用户看到回填内容后再回车才执行（所见即所发，也防 /com 误发未补全文本）
 * - `/name args...`（含空格，回填态或手输参数）→ 回车提交：命令带参 run(args)；无命令查 skill
 */
export function InputStream({
  onSubmit,
  onCommand,
  onSkillInvoke,
  onClear,
  placeholder,
  inactive,
  insert,
  onTabSandbox,
  onInterjectClear,
  onPasteImage,
  busy = false,
  onSlashBusy,
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
      // M11 审阅 P0-1：忙碌态斜杠在分流点拦截（/clear 等若立即执行会与 runLoop 竞态——
      // messagesRef 被清而 loop 持旧数组引用继续跑 = 僵尸循环）
      if (busy) {
        onSlashBusy?.()
        setCur(createCursor(''))
        return
      }
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

  // Enter：统一两段式（与 SkillPanel 回填一致，用户拍板）——
  // 命令名无空格 + 有匹配 → 回填 `/选中名 `（带尾随空格留参数位），不执行；
  // 再回车（此时文本含空格）或已带参数 → submit 全文走分流（命令带参 / skill 传参）
  const handleTextSubmit = (text: string): void => {
    if (text.startsWith('/') && !/\s/.test(text)) {
      const matches = matchSlashEntries(text.slice(1))
      if (matches.length > 0) {
        const idx = slashIdx >= 0 && slashIdx < matches.length ? slashIdx : 0
        setCur(createCursor(`/${matches[idx].name} `))
        return
      }
    }
    submit(text)
  }

  useInput((input, key) => {
    const slashMode = cur.text.startsWith('/')
    // M9-D13：Tab 专职沙箱模式循环——非 slash 补全态的空闲输入才拦截（面板内 Tab 由面板自处理）
    // M11-P7：Ctrl+U 清空插话队列（readline 清行同键）
    if (key.ctrl && input === 'u' && onInterjectClear !== undefined) {
      onInterjectClear()
      return
    }
    if (key.tab && !key.shift && onTabSandbox !== undefined && !slashMode) {
      onTabSandbox()
      return
    }
    // M10-P2b：Alt+V 读系统剪贴板图片（named meta 组合键；Ctrl+V 在 raw mode 是 0x16 字面字符不可用）。
    // 粘贴成功 → 短标签插入光标处（标签即引用，在输入框内可见可删——两家同款内嵌形态）
    if (input === 'v' && key.meta && onPasteImage !== undefined) {
      void onPasteImage().then((label) => {
        if (label === null || label === '') return
        setCur((c) => insertAtCursor(c, `${label} `))
        setHistIdx(-1)
      })
      return
    }
    if (slashMode) {
      const matches = matchSlashEntries(cur.text.slice(1))
      // 补全统一走回车两段式（↑↓ 选 + 回车回填）；Tab 不参与——已专职沙箱模式切换（M9-D13）
      if (key.upArrow && matches.length > 0) {
        setSlashIdx((i) => (i <= 0 ? matches.length - 1 : i - 1))
      } else if (key.downArrow && matches.length > 0) {
        setSlashIdx((i) => (i >= matches.length - 1 ? 0 : i + 1))
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
