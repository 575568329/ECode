/**
 * 输出查看器（M14 §3.5，V3）：被折叠的长内容（工具全文/后台任务日志/子代理 transcript）
 * 的"认真看"载体——任意长滚动 + 搜索 + 实时跟随。
 *
 * 核心原理：Ink 帧超视口会炸（全屏兜底 3J 清 scrollback），但**帧高恒定、内容在
 * state 里滚**完全安全——滚动 = offset 变化 → 重渲 slice(offset, offset+H)，内容
 * 10 万行也只有 H 行上屏。
 *
 * 两级结构：/output → OutputListPage（PanelShell：最近工具调用 + 后台任务 + 子代理
 * transcript 文件）→ Enter → OutputViewer（文本滚动窗）。
 *
 * Ctrl+P 快捷键不做（D5：斜杠命令零新键、"认真看"低频，快捷键收益小）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import wrapAnsi from 'wrap-ansi'
import { theme } from './theme.js'
import { PanelShell, type PanelRow } from './PanelShell.js'
import { clipWidth, sectionBudget, useViewport } from './viewport.js'
import { taskRegistry } from '../services/tasks.js'

// —— LineSource：查看器的数据面（§3.5）——

export interface LineSource {
  /** 全量物理行（已 wrap——查看器渲染不做每帧全量 wrap，性能红线） */
  lines(): string[]
  /** 运行中（follow 语义：新数据自动滚到底） */
  isGrowing(): boolean
  /** 增长通知（可选——文件类源 watch mtime 轮询） */
  subscribe?(cb: () => void): () => void
}

/** wrap 单逻辑行序列（与 viewport.foldLines 同参：hard 断长 token、保留缩进） */
function wrapAll(text: string, width: number): string[] {
  return text.split('\n').flatMap((l) => (l === '' ? [''] : wrapAnsi(l, width, { hard: true, trim: false }).split('\n')))
}

/** 审阅 P1-6：wrap 结果模块级缓存（键=源标识；校验=length+width——内容变化自然 miss）。
 *  三源共用：10 万行日志每次按键全量读盘+wrap 是帧级卡顿（性能红线自违反）；
 *  LRU 16 条防无界（条目=一次 wrap 的物理行数组）。 */
const wrapCache = new Map<string, { len: number; width: number; lines: string[] }>()
function cachedWrap(key: string, text: string, width: number): string[] {
  const hit = wrapCache.get(key)
  if (hit !== undefined && hit.len === text.length && hit.width === width) return hit.lines
  const lines = wrapAll(text, width)
  if (wrapCache.size >= 16) {
    const oldest = wrapCache.keys().next().value
    if (oldest !== undefined) wrapCache.delete(oldest)
  }
  wrapCache.set(key, { len: text.length, width, lines })
  return lines
}

/** ① 工具执行内容：来自 TuiApp 的 item/completed 帧环形缓冲。
 *  边界（v1.2 审阅）：前台 bash 有工具层 30KB 截断天花板——超限部分 transcript 也不存在，
 *  全文只有 run_in_background 任务日志有。
 *  审阅 P1-4：getTool getter 化（不闭包快照对象——item/read 异步补全后新对象即时可见，
 *  旧实现已打开的查看器持旧引用+cache 永不刷新，用户一直看 4KB 截断版）。 */
export interface RecentTool {
  itemId: string
  name: string
  content: string
  isError: boolean
  at: number
  /** 审阅 P1-5：帧内 content 被 4KB 截断（item/read 补全后清除） */
  truncated?: boolean
}

export function toolResultSource(getTool: () => RecentTool | undefined, width: number): LineSource {
  return {
    lines: () => {
      const t = getTool()
      if (t === undefined) return []
      return cachedWrap(`tool:${t.itemId}`, t.content, width)
    },
    isGrowing: () => false,
  }
}

/** ② 后台任务日志：读 outputFile 全量 + mtime 轮询增量通知。
 *  边界：TaskRegistry dispose 会 unlink 日志——只能 attach 现存任务（文件没了显示空）。 */
export function taskFileSource(taskId: string, width: number): LineSource {
  const snap = taskRegistry.snapshot().find((t) => t.id === taskId)
  const file = snap?.outputFile ?? ''
  const growing = snap?.status === 'running'
  const readLines = (): string[] => {
    if (file === '') return []
    try {
      // 审阅 P1-6：cachedWrap（内容长度校验——日志追加自然 miss 重建）
      return cachedWrap(`task:${taskId}`, readFileSync(file, 'utf8'), width)
    } catch {
      return []
    }
  }
  return {
    lines: readLines,
    isGrowing: () => growing && taskRegistry.snapshot().find((t) => t.id === taskId)?.status === 'running',
    subscribe: (cb) => {
      let lastMtime = 0
      const timer = setInterval(() => {
        try {
          const m = statSync(file).mtimeMs
          if (m !== lastMtime) {
            lastMtime = m
            cb()
          }
        } catch {
          /* 文件消失（任务清理）——静默 */
        }
      }, 500)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
}

/** ③ 子代理 transcript：~/.ecode/agents/<id>.jsonl 一行一条调用（只读快照）。 */
export function subagentSource(agentId: string, width: number): LineSource {
  const file = join(homedir(), '.ecode', 'agents', `${agentId}.jsonl`)
  const readLines = (): string[] => {
    try {
      return cachedWrap(`agent:${agentId}`, readFileSync(file, 'utf8'), width)
    } catch {
      return []
    }
  }
  return {
    lines: readLines,
    isGrowing: () => false,
  }
}

/** 列出可查看的子代理 transcript 文件（id + mtime + 首行摘要，新→旧）。
 *  F-26：裸 id 无可读性——逐文件读首 2KB 抽首条 user 文本做摘要；时间取文件 mtime。
 *  无项目归属标记（transcript 只含消息行），扫描范围=全部文件但列表只显示最近 maxShow 条
 *  （调用方截断）——避免跨项目历史条目刷屏。 */
export function listSubagentTranscripts(maxShow = 30): Array<{ id: string; mtimeMs: number; summary: string }> {
  try {
    return readdirSync(join(homedir(), '.ecode', 'agents'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = join(homedir(), '.ecode', 'agents', f)
        return { id: f.slice(0, -'.jsonl'.length), mtimeMs: statSync(full).mtimeMs, summary: readFirstUserText(full) }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxShow)
  } catch {
    return []
  }
}

/** F-26：transcript 首条 user 文本（读首 2KB 截取——大文件不全量读） */
function readFirstUserText(file: string): string {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 2048)
    for (const line of head.split('\n')) {
      if (line.trim() === '') continue
      try {
        const m = JSON.parse(line) as { role?: string; content?: unknown }
        if (m.role !== 'user') continue
        if (typeof m.content === 'string') return firstLine(m.content)
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text') {
              return firstLine(String((b as { text?: string }).text ?? ''))
            }
          }
        }
      } catch {
        /* 半行截断（2KB 边界）——跳过 */
      }
    }
  } catch {
    /* 读失败——无摘要 */
  }
  return ''
}

const firstLine = (s: string): string => (s.split('\n')[0] ?? '').trim()

// —— OutputViewer：文本滚动窗 ——

interface OutputViewerProps {
  title: string
  source: LineSource
  /** 返回列表页（Esc 逐级回退） */
  onBack: () => void
}

/** 搜索态：null=未搜索；string=已确认词（n/N 跳转） */
export function OutputViewer({ title, source, onBack }: OutputViewerProps): ReactElement {
  const { budget } = useViewport()
  // 内容窗高度（审阅 P0-2 修正）：帧高账目 = 面板（height + 骨架实占 5：marginTop1+边框2+
  // 标题1+状态1；搜索行出现时 +1）+ App 外部骨架 3（ActivityBar1+输入行1+StatusBar1）
  // ≤ budget（= rows−2，SAFETY_MARGIN 已在其中）。即 height ≤ budget−8；搜索行常驻留量
  // 取 reserve=10——原 6 漏算外部 3 行+吃掉安全余量，任何终端打开都恰满屏触发 3J
  const height = Math.max(3, sectionBudget(budget, 10))
  const lines = source.lines()
  const total = lines.length
  const [offset, setOffset] = useState(() => Math.max(0, total - height))
  const [followed, setFollowed] = useState(source.isGrowing())
  const [query, setQuery] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState<string | null>(null)
  const [, forceRerender] = useState(0)

  // 增长通知：重读 + follow 时滚到底
  useEffect(() => {
    const unsub = source.subscribe?.(() => {
      if (followedRef.current) {
        const t = source.lines().length
        setOffset(Math.max(0, t - heightRef.current))
      }
      forceRerender((n) => n + 1)
    })
    return unsub
  }, [source])
  const followedRef = useRef(followed)
  followedRef.current = followed
  const heightRef = useRef(height)
  heightRef.current = height

  const matches = useMemo(() => {
    if (query === null || query === '') return null
    const q = query.toLowerCase()
    const hits: number[] = []
    for (let i = 0; i < lines.length; i++) if (lines[i]?.toLowerCase().includes(q)) hits.push(i)
    return hits
  }, [query, lines])

  const jumpMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches === null || matches.length === 0) return
      // 当前 offset 起下一个/上一个匹配
      // "下一个/上一个"= 严格越过当前 offset（当前窗口的匹配自身不算——连续 n 逐个前进）
      let target: number | undefined
      if (dir === 1) target = matches.find((m) => m > offset)
      else target = [...matches].reverse().find((m) => m < offset)
      if (target === undefined) target = dir === 1 ? (matches[0] as number) : (matches[matches.length - 1] as number)
      setFollowed(false)
      setOffset(Math.max(0, Math.min(total - height, target)))
    },
    [matches, offset, total, height],
  )

  useInput((input, key) => {
    if (searchInput !== null) {
      // 搜索输入态：可打印追加/退格清/Enter 确认/Esc 取消
      if (key.escape) {
        setSearchInput(null)
      } else if (key.return) {
        setQuery(searchInput)
        setSearchInput(null)
        setFollowed(false)
      } else if (key.backspace || key.delete) {
        setSearchInput((s) => (s === null ? s : s.slice(0, -1)))
      } else if (input !== '') {
        setSearchInput((s) => (s ?? '') + input)
      }
      return
    }
    if (key.escape) {
      onBack()
      return
    }
    if (input === '/') {
      setSearchInput('')
      return
    }
    if (input === 'n') {
      jumpMatch(1)
      return
    }
    if (input === 'N') {
      jumpMatch(-1)
      return
    }
    if (input === 'f' || input === 'F') {
      setFollowed((f) => !f)
      if (!followed) setOffset(Math.max(0, total - height))
      return
    }
    if (input === 'g') {
      setFollowed(false)
      setOffset(0)
      return
    }
    if (input === 'G') {
      setFollowed(false)
      setOffset(Math.max(0, total - height))
      return
    }
    const page = Math.max(1, Math.floor(height / 2))
    if (key.upArrow) {
      setFollowed(false)
      setOffset((o) => Math.max(0, o - 1))
    } else if (key.downArrow) {
      setOffset((o) => Math.min(Math.max(0, total - height), o + 1))
    } else if (key.pageUp) {
      setFollowed(false)
      setOffset((o) => Math.max(0, o - page))
    } else if (key.pageDown) {
      setOffset((o) => Math.min(Math.max(0, total - height), o + page))
    }
  })

  const shown = lines.slice(offset, offset + height)
  const statusParts = [`L${offset + 1}-L${Math.min(total, offset + height)} / ${total}`]
  if (source.isGrowing()) statusParts.push(followed ? '[F]跟随中' : '[F]跟随(off)')
  if (matches !== null) statusParts.push(`匹配 ${matches.length}${query !== '' ? ` "/${query}"` : ''}`)
  statusParts.push('/搜索 · n/N 跳转 · Esc 返回')

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {title}
      </Text>
      <Box flexDirection="column" minHeight={height} height={height}>
        {shown.map((line, i) => (
          <Text key={offset + i} dimColor={false} wrap="truncate">
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </Box>
      {searchInput !== null && (
        <Text dimColor>
          /{searchInput}
          {'▏'}
        </Text>
      )}
      <Text dimColor>{statusParts.join(' · ')}</Text>
    </Box>
  )
}

// —— OutputListPage：/output 列表页 ——

/** 列表项 → 查看器入口（TuiApp 侧据此构造 LineSource） */
export type OutputEntry = { kind: 'tool'; tool: RecentTool } | { kind: 'task'; id: string } | { kind: 'agent'; id: string }

export interface OutputListPageProps {
  /** TuiApp 的最近工具调用环形缓冲（新→旧） */
  recentTools: RecentTool[]
  onOpen: (entry: OutputEntry) => void
  onExit: () => void
}

export function OutputListPage({ recentTools, onOpen, onExit }: OutputListPageProps): ReactElement {
  // 任务快照 + 轮询（运行中状态实时；子代理文件打开时快照）
  const [tasks, setTasks] = useState(() => taskRegistry.snapshot())
  const [agents] = useState(() => listSubagentTranscripts())
  useEffect(() => {
    const timer = setInterval(() => setTasks(taskRegistry.snapshot()), 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])
  const { columns } = useViewport()

  const rows = useMemo<Array<PanelRow<OutputEntry>>>(() => {
    // 审阅 P1-7：label 一律按显示宽度截断（columns−4 留边框缩进）——slice 按字符且 80 列
    // 终端普遍超宽，Ink wrap 成 2 物理行使 PanelShell 窗口化预算翻倍失效
    const max = Math.max(20, columns - 4)
    const out: Array<PanelRow<OutputEntry>> = []
    if (tasks.length > 0) {
      out.push({ type: 'header', label: '后台任务（运行中可实时跟随）' })
      for (const t of tasks) {
        const mark = t.status === 'running' ? '◉' : t.status === 'failed' ? '✗' : '○'
        out.push({
          type: 'item',
          value: { kind: 'task', id: t.id },
          label: clipWidth(`${mark} ${t.id} ${t.command}（${t.status}${t.exitCode !== null ? ` exit ${t.exitCode}` : ''}）`, max),
        })
      }
    }
    if (recentTools.length > 0) {
      out.push({ type: 'header', label: '最近工具调用' })
      for (const tool of recentTools.slice(0, 20)) {
        const preview = tool.content.split('\n')[0]?.slice(0, 48) ?? ''
        out.push({
          type: 'item',
          value: { kind: 'tool', tool },
          label: clipWidth(`${tool.isError ? '✗' : '·'} ${tool.name} ${preview}${tool.truncated === true ? ' 〔已截断〕' : ''}`, max),
        })
      }
    }
    if (agents.length > 0) {
      out.push({ type: 'header', label: '子代理 transcript（跨项目最近 30 条）' })
      for (const a of agents.slice(0, 10)) {
        // F-26：裸 id → 时间 + 首行摘要（历史条目不再是一串无意义 id）
        const t = new Date(a.mtimeMs)
        const pad = (n: number): string => String(n).padStart(2, '0')
        const when = `${t.getMonth() + 1}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
        const sum = a.summary === '' ? a.id : a.summary
        out.push({ type: 'item', value: { kind: 'agent', id: a.id }, label: clipWidth(`§ ${when} ${sum}`, max) })
      }
    }
    return out
  }, [tasks, recentTools, agents, columns])

  return (
    <PanelShell
      title="/output 输出查看"
      subtitle="Enter 查看全文 · 运行中任务实时跟随"
      rows={rows}
      onPick={onOpen}
      onCancel={onExit}
      emptyHint="暂无可查看的输出（工具调用/后台任务/子代理）"
      keyHints="↑↓ 选择 · 回车 查看 · Esc 返回"
    />
  )
}
