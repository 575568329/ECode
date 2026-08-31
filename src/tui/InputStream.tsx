import { useState, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useInput, Text, Box } from 'ink'
import { TextInput } from './TextInput.js'
import { createCursor, insert as insertAtCursor, type CursorState } from './cursor.js'
import { commandRegistry, type Command, type CommandResult } from '../commands/registry.js'
import { skillRegistry } from '../services/skill.js'
import { extractAtQuery, listAtEntries, applyAtCompletion, type AtEntry } from './atsuggest.js'
import { loadInputHistory, appendInputHistory } from './inputHistory.js'

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

/** F-46：忙碌态放行的只读命令白名单——纯读快照零竞态（/output 看子代理实时 transcript、
 *  /warnings 告警历史、/help 命令列表）；其余命令 busy 仍拦（/clear 与 runLoop 竞态等）。 */
const BUSY_READONLY_SLASH = new Set(['output', 'warnings', 'help'])

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
      <Text dimColor> ↑↓ 选择 · 回车 填入 · Esc 取消（填入后：再回车执行 / Esc 清空）</Text>
    </Box>
  )
}

/** @ 文件补全下拉（界面批 A1）：SlashSuggest 同款窗口化形态（≤6 行 + 计数提示，预算同族） */
export function AtSuggest({
  entries,
  selectedIdx,
  query,
}: {
  entries: AtEntry[]
  selectedIdx: number
  query: string
}): ReactElement | null {
  if (entries.length === 0) return null
  const start = selectedIdx >= SUGGEST_MAX_ROWS ? Math.min(selectedIdx - SUGGEST_MAX_ROWS + 1, entries.length - SUGGEST_MAX_ROWS) : 0
  const visible = entries.slice(start, start + SUGGEST_MAX_ROWS)
  const hidden = Math.max(0, entries.length - (start + SUGGEST_MAX_ROWS))
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {start > 0 && <Text dimColor> ↑ 还有 {start} 条（共 {entries.length} 项）</Text>}
      {visible.map((e, i) => (
        <Text key={e.rel} inverse={start + i === selectedIdx}>
          @{e.rel}
          {e.dir ? '/' : ''} <Text dimColor>{e.dir ? '目录' : '文件'}</Text>
        </Text>
      ))}
      {hidden > 0 && <Text dimColor> ↓ 还有 {hidden} 条（共 {entries.length} 项）</Text>}
      <Text dimColor> @「{query}」 ↑↓ 选择 · Tab/回车 补全 · Esc 关闭</Text>
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
  /**
   * 审阅 P1-1：主输入框草稿权威挂口（审批卡 hasDraft 判定用）。非 undefined 时挂载即
   * 注册（InputDraft.read 返回 cur.text——inactive 期间仍真实），卸载/换实例时以 null
   * 注销；cur.text 每变化回调 onDraftChange（TuiApp 同步 state 镜像驱动 ConfirmPrompt）
   */
  onRegisterDraft?: (port: { read(): string } | null) => void
  /** 与 onRegisterDraft 配套：cur.text 变化通知（缺省忽略） */
  onDraftChange?: (text: string) => void
  /** 清账 III P2-1：@ 下拉开着与否的同步读挂口（TuiApp 双击 Esc 守卫用；null=不支持） */
  onRegisterAtOpen?: (port: { read(): boolean } | null) => void
  /** M9-P4/D13：Tab 专职沙箱模式循环（主输入空闲态；slash/@ 补全态不拦截） */
  onTabSandbox?: () => void
  /** M10-P2b：Alt+V 粘贴剪贴板图片（图片数据不走 stdin，须专用键位主动读系统剪贴板）。
   * 返回插入输入框的短标签（[图片#N]，无图 null）——标签即引用，删标签=删图（两家同款内嵌形态） */
  onPasteImage?: () => Promise<string | null>
  /** 输入体验批二期：大块插入（粘贴）token 化判定回调——返回 token 文本则插入 token
   * （全文存父级 pastedContents，提交时展开），null=原文直插（CC onTextPaste 同构） */
  onPasteText?: (text: string) => string | null
  /** 输入体验批二期审阅 P1：提交入口的粘贴 token 展开回调——历史记录（input-history.json
   * 持久化）必须记展开后全文：若把 token 形态记进历史，store 剪枝后按 ↑ 召回即产孤儿
   * token，粘贴全文永久丢失。在历史落盘**之前**展开。 */
  onExpandPaste?: (text: string) => string
  /** 审阅 P2：Ctrl+R 搜索态同步读挂口（TuiApp 双击 Esc armed 守卫用；同 atOpen 端口族） */
  onRegisterSearchOpen?: (port: { read(): boolean } | null) => void
  /** M11-P7：Ctrl+U 清空插话队列（readline 清行习惯键位；防「排了又后悔」） */
  onInterjectClear?: () => void
  /** M11 审阅 P0-1：忙碌态（斜杠拦截必须在 InputStream 分流点——TuiApp.submit 里的守卫不可达，
   * 因为本组件的 submit() 对 / 前缀文本直接走命令分流，不经 onSubmit） */
  busy?: boolean
  /** 忙碌态收到斜杠命令时的宿主提示回调（不执行不排队） */
  onSlashBusy?: () => void
  /** 界面批 A2：输入历史持久化目录（缺省 process.cwd()——项目级 .ecode/input-history.json） */
  cwd?: string
}

/**
 * 输入流：TextInput + 历史（↑↓，A2 持久化项目级 + Ctrl+R 增量搜索）+ / 补全（↑↓ 选中 +
 * 回车两段式回填）+ @ 文件补全（A1：↑↓/Tab·Enter 补全、Esc 关闭）。
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
  onRegisterDraft,
  onDraftChange,
  onRegisterAtOpen,
  onTabSandbox,
  onInterjectClear,
  onPasteImage,
  onPasteText,
  onExpandPaste,
  onRegisterSearchOpen,

  busy = false,
  onSlashBusy,
  cwd,
}: InputStreamProps): ReactElement {
  const cwdRef = useRef(cwd ?? process.cwd())
  cwdRef.current = cwd ?? process.cwd()
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))
  const [history, setHistory] = useState<string[]>(() => loadInputHistory(cwdRef.current))
  const [histIdx, setHistIdx] = useState(-1)
  const [slashIdx, setSlashIdx] = useState(-1)
  // 界面批 A1：@ 补全态（候选 + 选中；候选由 effect 异步列目录，token 防乱序回填）
  const [atEntries, setAtEntries] = useState<AtEntry[]>([])
  const [atIdx, setAtIdx] = useState(0)
  const atTokenRef = useRef(0)
  const atQueryRef = useRef<{ atIdx: number; query: string } | undefined>(undefined)
  /** Esc 关闭 @ 补全的锚（`atIdx:query`）——同锚不重开，改词/挪 @ 后自然恢复 */
  const atDismissedRef = useRef<string | null>(null)
  // 界面批 A2：Ctrl+R 增量搜索态（query 过滤 + idx 在匹配集内循环）
  const [search, setSearch] = useState<{ query: string; idx: number } | null>(null)
  const lastInsertSeq = useRef(-1)
  // 审阅 P1-1：cur 引用挂口（闭包不 stale；onRegisterDraft 仅挂载/卸载各调一次）
  const curRef = useRef(cur)
  curRef.current = cur

  // 草稿权威注册（挂载注册 / 卸载注销；身份回调由父保证稳定）
  // 审阅 P2：搜索态活值端口（挂载期注册；TuiApp escArm 守卫读）
  const searchOpenRef = useRef(false)
  searchOpenRef.current = search !== null
  useEffect(() => {
    onRegisterSearchOpen?.({ read: () => searchOpenRef.current })
    return () => onRegisterSearchOpen?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次
  }, [])
  useEffect(() => {
    onRegisterDraft?.({ read: () => curRef.current.text })
    return () => onRegisterDraft?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（onRegisterDraft 由父 useCallback 保证稳定）
  }, [])
  useEffect(() => {
    onDraftChange?.(cur.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cur.text 变化即通知（onDraftChange 父侧稳定）
  }, [cur.text])

  // 清账 III P2-1：@ 下拉开着端口（atEntries 非空即开——挂载注册/卸载注销，与 draft 端口同族）
  const atOpenRef = useRef(false)
  atOpenRef.current = atEntries.length > 0
  useEffect(() => {
    onRegisterAtOpen?.({ read: () => atOpenRef.current })
    return () => onRegisterAtOpen?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（onRegisterAtOpen 由父保证稳定）
  }, [])

  // cur.text 变化时重置 slashIdx：有匹配默认选中第一个（UI 高亮 + 回车执行第一个），
  // 无匹配 -1（不显示建议列表）
  useEffect(() => {
    const matches = cur.text.startsWith('/') ? matchSlashEntries(cur.text.slice(1)) : []
    setSlashIdx(matches.length > 0 ? 0 : -1)
  }, [cur.text])

  // A1：@ 查询词变化 → 异步列候选（token 防乱序；Esc 关闭锚内不触发）
  const atQuery = search === null ? extractAtQuery(cur.text, cur.caret) : undefined
  atQueryRef.current = atQuery
  const atKey = atQuery !== undefined ? `${atQuery.atIdx}:${atQuery.query}` : null
  useEffect(() => {
    if (atQuery === undefined) {
      setAtEntries([])
      return
    }
    if (atDismissedRef.current === `${atQuery.atIdx}:${atQuery.query}`) {
      setAtEntries([]) // Esc 已关闭此锚：不重开（继续输入合法字符不触发；改词后恢复）
      return
    }
    const token = ++atTokenRef.current
    void listAtEntries(cwdRef.current, atQuery.query).then((entries) => {
      if (atTokenRef.current === token) setAtEntries(entries)
    })
    setAtIdx(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- atKey 变化即重列（闭包 cwdRef 稳定）
  }, [atKey])

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
    // A2：提交即落盘 + 会话内镜像（去重移尾；命令也记——重发命令是高频诉求）
    appendInputHistory(cwdRef.current, trimmed)
    setHistory((h) => [...h.filter((e) => e !== trimmed), trimmed])
    if (trimmed.startsWith('/')) {
      const sp = trimmed.indexOf(' ')
      const name = sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)
      const args = sp === -1 ? undefined : trimmed.slice(sp + 1).trim()
      // M11 审阅 P0-1：忙碌态斜杠在分流点拦截（/clear 等若立即执行会与 runLoop 竞态——
      // messagesRef 被清而 loop 持旧数组引用继续跑 = 僵尸循环）
      // 批2b 配套：只提示不吞——命令文本保留在输入框（用户空闲后补发，不须重打）
      // F-46：只读查看类白名单 busy 放行——/output（看子代理实时 transcript）/warnings/
      // help 均纯读快照零竞态；子代理运行期「看不了在干什么」的堵点正在于此
      if (busy && !BUSY_READONLY_SLASH.has(name)) {
        onSlashBusy?.()
        return
      }
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
    }
    setCur(createCursor(''))
    setHistIdx(-1)
  }

  // A1：@ 补全回填（`@query` → `@rel/` 或 `@rel `）——返回 true 表示已消费本次提交
  const tryAtComplete = (): boolean => {
    const q = atQueryRef.current
    if (q === undefined || atEntries.length === 0) return false
    const entry = atEntries[Math.min(atIdx, atEntries.length - 1)]
    if (entry === undefined) return false
    setCur((c) => createCursor(applyAtCompletion(c.text, q.atIdx, entry)))
    atDismissedRef.current = null // 补全后新查询词（带尾 / 或空格分隔）自然重开下一级
    return true
  }

  // Enter：统一两段式（与 SkillPanel 回填一致，用户拍板）——
  // @ 补全态优先：回车=补全（Tab 同义）；命令名无空格 + 有匹配 → 回填 `/选中名 `（带尾随
  // 空格留参数位），不执行；再回车（此时文本含空格）或已带参数 → submit 全文走分流
  const handleTextSubmit = (rawText: string): void => {
    // 审阅 P1：先展开粘贴 token 再进历史/分流——历史与命令实参拿到的都是全文
    const text = onExpandPaste !== undefined ? onExpandPaste(rawText) : rawText
    if (tryAtComplete()) return
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

  /** A2：当前搜索词的匹配集（新→旧排列——Ctrl+R 默认落在最近一条） */
  const searchMatches = (): string[] => {
    if (search === null) return []
    const q = search.query.toLowerCase()
    const matched = [...history].reverse().filter((h) => h.toLowerCase().includes(q))
    return matched.length > 0 ? matched : []
  }

  useInput((input, key) => {
    // A2：Ctrl+R 增量搜索（进入 / 循环下一个匹配）
    if (key.ctrl && input === 'r') {
      if (search === null) {
        setSearch({ query: '', idx: 0 })
      } else {
        const m = searchMatches()
        if (m.length > 0) setSearch({ ...search, idx: (search.idx + 1) % m.length })
      }
      return
    }
    // A2：搜索态独占键位（字符进 query；Enter/Esc 退出并保留填入；↑↓ 浏览）
    if (search !== null) {
      const m = searchMatches()
      if (key.escape) {
        setSearch(null)
        return
      }
      if (key.return) {
        if (m.length > 0) setCur(createCursor(m[Math.min(search.idx, m.length - 1)] ?? ''))
        setSearch(null)
        return
      }
      if (key.upArrow && m.length > 0) {
        setSearch({ ...search, idx: Math.max(0, search.idx - 1) })
        return
      }
      if (key.downArrow && m.length > 0) {
        setSearch({ ...search, idx: Math.min(m.length - 1, search.idx + 1) })
        return
      }
      if (key.backspace) {
        setSearch({ query: search.query.slice(0, -1), idx: 0 })
        return
      }
      if (!key.ctrl && !key.meta && !key.escape && input !== '') {
        setSearch({ query: search.query + input, idx: 0 })
        return
      }
      return
    }
    const slashMode = cur.text.startsWith('/')
    const atMode = atQueryRef.current !== undefined && atEntries.length > 0
    // M9-D13：Tab 专职沙箱模式循环——非 slash/@ 补全态的空闲输入才拦截（面板内 Tab 由面板自处理）
    // A1：@ 补全态 Tab = 补全选中项
    // M11-P7：Ctrl+U 清空插话队列（readline 清行同键）
    if (key.ctrl && input === 'u' && onInterjectClear !== undefined) {
      onInterjectClear()
      return
    }
    if (key.tab && !key.shift && atMode) {
      tryAtComplete()
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
      // 批2b 配套：回填态（`/name ` 尾随空格无参数）Esc 取消——两段式残留吞消息的出口
      if (key.escape && /\s$/.test(cur.text)) {
        setCur(createCursor(''))
        return
      }
      // 补全统一走回车两段式（↑↓ 选 + 回车回填）；Tab 不参与——已专职沙箱模式切换（M9-D13）
      if (key.upArrow && matches.length > 0) {
        setSlashIdx((i) => (i <= 0 ? matches.length - 1 : i - 1))
      } else if (key.downArrow && matches.length > 0) {
        setSlashIdx((i) => (i >= matches.length - 1 ? 0 : i + 1))
      }
      return
    }
    // A1：@ 补全态 ↑↓ 选择 / Esc 关闭（只关下拉不吞文本——后续输入照常进输入框）
    if (atMode) {
      if (key.upArrow) {
        setAtIdx((i) => (i <= 0 ? atEntries.length - 1 : i - 1))
        return
      }
      if (key.downArrow) {
        setAtIdx((i) => (i >= atEntries.length - 1 ? 0 : i + 1))
        return
      }
      if (key.escape) {
        const q = atQueryRef.current
        if (q !== undefined) atDismissedRef.current = `${q.atIdx}:${q.query}`
        setAtEntries([])
        return
      }
      // 其余键（含 Enter 提交）不在此拦——Enter 走 handleTextSubmit 的 tryAtComplete
    }
    // 历史（非 slash/@ 模式）
    if (key.upArrow && history.length > 0) {
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(idx)
      setCur(createCursor(history[idx] ?? ''))
    } else if (key.downArrow && histIdx >= 0) {
      const idx = histIdx + 1
      if (idx >= history.length) {
        setHistIdx(-1)
        setCur(createCursor(''))
      } else {
        setHistIdx(idx)
        setCur(createCursor(history[idx] ?? ''))
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
        inactive={inactive || search !== null}
        onPasteText={onPasteText}
      />
      {search !== null ? (
        // A2：搜索提示行（1 行，替换补全下拉位——同预算族）
        <Box paddingLeft={2}>
          <Text dimColor>
            搜索: {search.query === '' ? '（输入即过滤）' : search.query}
            {searchMatches().length > 0 ? ` 〔${Math.min(search.idx, searchMatches().length - 1) + 1}/${searchMatches().length}〕` : '（无匹配）'}
            {' '}Ctrl+R 下一条 · ↑↓ 浏览 · 回车 填入 · Esc 退出
          </Text>
        </Box>
      ) : (
        <>
          <SlashSuggest text={cur.text} selectedIdx={slashIdx} />
          {atQueryRef.current !== undefined && (
            <AtSuggest entries={atEntries} selectedIdx={atIdx} query={atQueryRef.current.query} />
          )}
        </>
      )}
    </Box>
  )
}
