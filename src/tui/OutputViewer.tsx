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
import { PanelShell, isMouseInput, type PanelRow } from './PanelShell.js'
import { clipWidth, sectionBudget, useViewport } from './viewport.js'
import { taskRegistry } from '../services/tasks.js'
import { isAgentActive } from '../services/subagent.js'
import { stripUntrustedAnsi } from './sanitize.js'
import { isBoundary, isRewind, isThinking } from '../core/types.js'
import { makeToolDigest } from '../protocol/toolDigest.js'
import { toolIcon } from './symbols.js'
import { CONTINUE_PROMPT } from '../core/loop.js'

// —— LineSource：查看器的数据面（§3.5）——

export interface LineSource {
  /** 全量物理行（已 wrap——查看器渲染不做每帧全量 wrap，性能红线） */
  lines(): string[]
  /** 运行中（follow 语义：新数据自动滚到底） */
  isGrowing(): boolean
  /** 增长通知（可选——文件类源 watch mtime 轮询） */
  subscribe?(cb: () => void): () => void
}

/** wrap 单逻辑行序列（与 viewport.foldLines 同参：hard 断长 token、保留缩进）。导出供单测。 */
export function wrapAll(text: string, width: number): string[] {
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

/** 面板折行宽度（项 4：resize 实时跟随——各源 lines() 内每次取，缓存按 width 校验自动重建） */
export function panelWidth(): number {
  return Math.max(10, (process.stdout.columns ?? 80) - 4)
}

export function toolResultSource(getTool: () => RecentTool | undefined, getWidth: () => number): LineSource {
  return {
    lines: () => {
      const t = getTool()
      if (t === undefined) return []
      // F-47：不可信内容净化在 cachedWrap 之前（strip 改变长度，事后剥破坏 len 校验）
      return cachedWrap(`tool:${t.itemId}`, stripUntrustedAnsi(t.content), getWidth())
    },
    isGrowing: () => false,
  }
}

/** ② 后台任务日志：读 outputFile 全量 + mtime 轮询增量通知。
 *  边界：TaskRegistry dispose 会 unlink 日志——只能 attach 现存任务（文件没了显示空）。 */
export function taskFileSource(taskId: string, getWidth: () => number): LineSource {
  const snap = taskRegistry.snapshot().find((t) => t.id === taskId)
  const file = snap?.outputFile ?? ''
  const growing = snap?.status === 'running'
  const readLines = (): string[] => {
    if (file === '') return []
    try {
      // 审阅 P1-6：cachedWrap（内容长度校验——日志追加自然 miss 重建）
      // F-47：净化在 wrap 之前（同上）
      return cachedWrap(`task:${taskId}`, stripUntrustedAnsi(readFileSync(file, 'utf8')), getWidth())
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

  /** F-50：执行时间线——全部对话按执行顺序线性展示（用户消息/模型文本/工具调用+结果摘要，
   *  web 端对话页同构）。Ctrl+T 默认落地视图：看完整执行顺序与模型思考路径。
   *  输入体验批（2026-08-31 用户反馈）：时间线格式与主对话流**同构**——用户消息 ❯ 前缀+
   *  主题背景色（SGR 逐行绘制，净化白名单放行）+全文不截断+空行边距（旧实现 JSON.stringify
   *  压平 preview 300 字符，用户"找不到自己输入的内容"）；assistant ◆（对话栅格同款，
   *  D3 二次翻案与主视图同步）。
   *  虚拟化：OutputViewer 本身固定窗 slice（只渲 offset..height）——本源负责「格式化缓存」：
   *  审阅 P2 改逐消息缓存（WeakMap 按消息对象身份——transcript 只追加、历史消息引用稳定），
   *  新消息到达只格式化增量；滚动 offset 变化/按键重渲不触发任何重算。 */
export function timelineSource(getMessages: () => readonly unknown[], getWidth: () => number): LineSource {
  const perMsg = new WeakMap<object, { width: number; lines: string[] }>()
  let cache: { count: number; lastKey: unknown; width: number; lines: string[] } | null = null
  const formatMsg = (m: unknown, width: number, results?: Map<string, { isError?: boolean; content?: string }>): string[] => {
    // WeakMap 键必须对象——畸形行（原始字符串等）直格式化不缓存（审阅 D4 补测抓出）。
    // 增量②注：results 配对表变化（新结果到达）时同对象缓存可能短暂滞后一行（800ms 轮询窗内自愈）
    const cacheable = m !== null && typeof m === 'object'
    if (cacheable) {
      const hit = perMsg.get(m as object)
      if (hit !== undefined && hit.width === width) return hit.lines
    }
    const lines = formatTimelineMessage(m, width, results)
    if (cacheable) perMsg.set(m as object, { width, lines })
    return lines
  }
  const readLines = (): string[] => {
    const width = getWidth() // 项 4：resize 实时跟随（缓存按 width 校验自动重建）
    const msgs = getMessages()
    const last = msgs.at(-1)
    if (cache !== null && cache.count === msgs.length && cache.lastKey === last && cache.width === width) {
      return cache.lines
    }
    // 增量②：预扫 tool_result 配对表（结果在相邻 user 消息——主对话流 commit.ts 同款手法；
    // 有新消息时重建，WeakMap 行缓存对同消息复用不受影响）
    const results = new Map<string, { isError?: boolean; content?: string }>()
    for (const m of msgs) {
      if (m !== null && typeof m === 'object' && (m as { role?: string }).role === 'user') {
        for (const b of ((m as { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: string }> }).content ?? [])) {
          if (b.type === 'tool_result' && b.tool_use_id !== undefined) {
            results.set(b.tool_use_id, { isError: b.is_error === true, content: b.content })
          }
        }
      }
    }
    const out: string[] = []
    for (const m of msgs) out.push(...formatMsg(m, width, results))
    cache = { count: msgs.length, lastKey: last, width, lines: out }
    return out
  }
  return {
    lines: readLines,
    isGrowing: () => true, // 对话持续增长——follow 跟随到底部
    subscribe: (cb) => {
      const timer = setInterval(cb, 800)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
}

// —— 时间线消息格式化（输入体验批：与主对话流同构）——

const ESC = String.fromCharCode(27)
/** 主题色 → SGR（净化白名单放行纯数字参数；hex '#RRGGBB' → 24bit 前景/背景） */
const sgrFg = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  return `${ESC}[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}
const sgrBg = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  return `${ESC}[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}
const SGR_RESET = `${ESC}[0m`
const SGR_DIM = `${ESC}[2m`

/** 时间线单条消息 → 物理行（与主对话流同栅格语言：用户 ❯ 背景块、assistant ● markdown、
 *  工具 ▸ 单行摘要；块间空行=对话 GAP.block 边距节奏）。行数安全：虚拟窗口按行滚。 */
export function formatTimelineMessage(m: unknown, width: number, results?: Map<string, { isError?: boolean; content?: string }>): string[] {
  const inner = Math.max(10, width - 2)
  const preview = (s: unknown, n = 200): string => {
    const text = String(s ?? '').replace(/\s+/g, ' ').trim()
    return text.length > n ? text.slice(0, n) + '…' : text
  }
  if (m !== null && typeof m === 'object') {
    const rec = m as Record<string, unknown>
    // boundary/rewind 标记行（对话流同款语义提示）——用类型守卫（compact_boundary 字段名别猜）
    if (isBoundary(m as never)) {
      return ['', `${SGR_DIM}⋯ 已压缩对话（此处之上 ${String(rec.tailStartIndex ?? '')} 条已摘要进上下文）${SGR_RESET}`, '']
    }
    if (isRewind(m as never)) {
      return ['', `${SGR_DIM}⇺ 已回退（快照 seq ${String(rec.seq ?? '')}），此点之后的对话不再进入上下文${SGR_RESET}`, '']
    }
    // 活动流 D4-B：思考行（折叠行 + 正文块——面板天然无超限，全文渲染）
    if (isThinking(m as never)) {
      const secs = Math.max(1, Math.round(Number(rec.durMs ?? 0) / 1000))
      const out = ['', `${SGR_DIM}✻ 思考 · 持续了 ${secs} 秒${SGR_RESET}`]
      const raw = String(rec.text ?? '')
      if (raw !== '') {
        out.push('')
        wrapAll(stripUntrustedAnsi(raw), inner).forEach((l) => out.push(`${SGR_DIM}  ${l}${SGR_RESET}`))
      }
      out.push('')
      return out
    }
    if (rec.role === 'user' && Array.isArray(rec.content)) {
      const blocks = rec.content as Array<{ type?: string; text?: string; content?: unknown }>
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
      const results = blocks.filter((b) => b.type === 'tool_result')
      const out: string[] = []
      // 用户消息：❯ + 主题背景色逐行绘制 + 全文不截断（与主对话 UserMessage 同构）
      if (text !== '' && text !== CONTINUE_PROMPT) {
        out.push('')
        const wrapped = wrapAll(stripUntrustedAnsi(text), inner)
        const bg = sgrBg(theme.userBg)
        const fg = sgrFg(theme.user)
        const icon = `${sgrFg(theme.info)}❯ ${fg}`
        wrapped.forEach((w, i) => {
          const padded = `${w} `.padEnd(Math.max(10, width), ' ')
          out.push(i === 0 ? `${bg}${icon}${padded}${SGR_RESET}` : `${bg}${fg}${padded}${SGR_RESET}`)
        })
        out.push('')
      }
      // 工具结果摘要（对话里折进工具组的部分——时间线保执行顺序可读性）
      for (const r of results) {
        const innerText = typeof r.content === 'string' ? r.content : JSON.stringify(r.content) ?? ''
        out.push(`${SGR_DIM}  └ ${preview(stripUntrustedAnsi(innerText), 160)}${SGR_RESET}`)
      }
      return out
    }
    if (rec.role === 'assistant' && Array.isArray(rec.content)) {
      const out: string[] = []
      for (const b of rec.content as Array<{ type?: string; text?: string; name?: string }>) {
        if (b.type === 'text') {
          const raw = String(b.text ?? '')
          const clipped = raw.length > 4000 ? raw.slice(0, 4000) : raw
          // 审阅 P1（2026-08-31）：模型文本=不可信面（可回显被读文件内容），OSC 全族 Ink
          // 净化层特意保留——mdBlock 前必须 strip（与 commit.ts:84 assistant 路径同契约）；
          // 且 mdBlock 逻辑行须 wrapAll（viewer 渲染 wrap="truncate" 不折行会截断不可见）
          out.push('')
          mdBlock(stripUntrustedAnsi(clipped)).forEach((l, i) => {
            // D3 二次翻案同批：正文行 ◆ 与工具行 ● 区分（主视图/面板同构——a46e50f 漏改面补齐）
            const prefix = i === 0 ? '◆ ' : '  '
            wrapAll(prefix + l, inner).forEach((w, j) => out.push(j === 0 ? w : '  ' + w))
          })
          out.push('')
        } else if (b.type === 'tool_use') {
          // 活动流增量②（G+）：面板工具行与主对话流同构——toolIcon 按类型图标 + makeToolDigest
          // 单源摘要 + 跨消息 tool_result 配对（✓/✗ + 结果首行 preview；commit.ts:31-39 同款手法）
          const name = String(b.name ?? '')
          const digest = makeToolDigest(name, (b as { input?: unknown }).input)
          const r = results?.get(String((b as { id?: string }).id ?? ''))
          const tail = r === undefined ? '' : r.isError === true ? ' ✗' : ' ✓'
          out.push(`  ${sgrFg(theme.tool)}${toolIcon(name)}${SGR_RESET} ${name} ${SGR_DIM}${digest}${SGR_RESET}${tail}`)
          if (r !== undefined && typeof r.content === 'string' && r.content !== '') {
            out.push(`    ${SGR_DIM}⎿ ▸ ${preview(stripUntrustedAnsi(r.content), 160)}${SGR_RESET}`)
          }
        }
      }
      return out
    }
  }
  // 非消息行（子代理事件等外来形态）退化为原行
  return typeof m === 'string' ? [stripUntrustedAnsi(m).slice(0, width)] : [stripUntrustedAnsi(JSON.stringify(m)).slice(0, width)]
}

  /** ③ 子代理 transcript：~/.ecode/agents/<id>.jsonl（只读快照）。
   *  F-46：运行期可见——文件含两类行：事件行（kind=meta/tool_start/tool_result/warn，
   *  子代理执行中逐条追加）与终态 messages 行（结束后全量重写）。渲染统一格式化为
   *  人读行；isGrowing=true + mtime 轮询 subscribe——运行中每 500ms 检查增长自动刷新。 */
export function subagentSource(agentId: string, getWidth: () => number): LineSource {
  const file = join(homedir(), '.ecode', 'agents', `${agentId}.jsonl`)
  // 审阅 T4：mtime+size 校验缓存——原实现每次渲染全量读盘+逐行 JSON.parse+format+wrap
  // （兄弟源都走 cachedWrap，性能红线自违反）；运行期文件追加 mtime/size 必变自然失效
  let cache: { mtimeMs: number; size: number; width: number; lines: string[] } | null = null
  const readLines = (): string[] => {
    const width = getWidth() // 项 4：resize 实时跟随
    let st: { mtimeMs: number; size: number }
    try {
      const s = statSync(file)
      st = { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return cache?.lines ?? [] // 文件尚未创建/被清理——缓存仍在则展示旧内容
    }
    if (cache !== null && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.width === width) {
      return cache.lines
    }
    try {
      const raw = readFileSync(file, 'utf8')
      const out: string[] = []
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        // F-46b：格式化后按宽度 hard wrap（LineSource 契约=source 负责物理行化）；
        // 续行缩进 2 列与 ⚙/✓ 层级对齐
        for (const logical of formatAgentLine(line, width)) {
          // F-47：先净化再 wrap（strip 改变内容长度）
          out.push(...wrapAll(stripUntrustedAnsi(logical), Math.max(10, width - 2)).map((l, i) => (i === 0 ? l : '  ' + l)))
        }
      }
      cache = { ...st, width, lines: out }
      return out
    } catch {
      return cache?.lines ?? []
    }
  }
  return {
    lines: readLines,
    isGrowing: () => true,
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
          /* 文件尚未创建（子代理未落首行）——继续轮询 */
        }
      }, 500)
      timer.unref?.() // 审阅 P2：兄弟源均有，补齐（防持有事件循环）
      return () => clearInterval(timer)
    },
  }
}

/** F-46：transcript 单行格式化（事件行/消息行 → 人读文本；parse 失败原样透出）。导出供单测锁格式。 */
export function formatAgentLine(line: string, width: number): string[] {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(line) as Record<string, unknown>
  } catch {
    return [line]
  }
  const preview = (s: unknown, n = 200): string => {
    const text = String(s ?? '').replace(/\s+/g, ' ').trim()
    return text.length > n ? text.slice(0, n) + '…' : text
  }
  const kind = j.kind
  if (kind === 'meta') return [`▶ 子任务 [${String(j.type ?? 'general')}] ${preview(j.description)}`]
  if (kind === 'tool_start') return [`  ⚙ ${String(j.name)}`]
  if (kind === 'tool_result') return [`  ✓ ${String(j.name)} 完成`]
  if (kind === 'warn') return [`  ⚠ ${preview(j.text)}`]
  if (kind === 'event') return [line.slice(0, width)]
  // 终态 messages 行（role/content）
  const role = j.role
  if (role === 'user') {
    const c = j.content
    if (typeof c === 'string') return [`▶ user: ${preview(c, 300)}`]
    if (Array.isArray(c)) {
      // F-46b：tool_result 块显示输出摘要（此前只落 'tool_result' 一词无信息）；text 块拼句
      const parts: string[] = []
      for (const b of c as Array<{ type?: string; text?: string; content?: unknown }>) {
        if (b.type === 'tool_result') {
          const inner = typeof b.content === 'string' ? b.content : JSON.stringify(b.content) ?? ''
          parts.push(`└ 结果: ${preview(inner, 160)}`)
        } else if (b.type === 'text') parts.push(preview(b.text, 160))
        else if (b.type !== undefined) parts.push(`[${b.type}]`)
      }
      return parts.length > 0 ? [`▶ user: ${parts.join('  ')}`] : []
    }
    return []
  }
  if (role === 'assistant') {
    const c = j.content as Array<{ type?: string; text?: string; name?: string }> | undefined
    if (!Array.isArray(c)) return []
    // 项 9：text 块走块级 markdown（◆ 前缀首行——对话栅格同款 D3 二次翻案、续行缩进 2 对齐 ⚙ 层级）；
    // 字符上限 4000（保留代码块/段落结构——旧 preview(300) 的空白压平会摧毁块结构）
    return c.flatMap((b) => {
      if (b.type === 'text') {
        const raw = String(b.text ?? '')
        const clipped = raw.length > 4000 ? raw.slice(0, 4000) : raw
        return mdBlock(clipped).map((l, i) => (i === 0 ? `◆ ${l}` : `  ${l}`))
      }
      if (b.type === 'tool_use') return [`  ⚙ ${String(b.name)}`]
      return [`  · ${String(b.type ?? '')}`]
    })
  }
  return [line.slice(0, width)]
}

/** F-50b：行内轻量 markdown——**粗体** 与 \`行内代码\` 上色（SGR 通道已放行）。 */
function mdInline(text: string): string {
  const ESC = String.fromCharCode(27)
  return text
    .replace(/\*\*([^*]+)\*\*/g, `${ESC}[1m$1${ESC}[22m`)
    .replace(/`([^`]+)`/g, `${ESC}[36m$1${ESC}[0m`)
}

/** 项 9（方案 A 二期）：块级 markdown——把一条 assistant 文本格式化为多逻辑行。
 *  支持块级：围栏代码块（dim+缩进，遵 F-42「代码块无边框」口味）/ 标题（加粗）/
 *  引用（dim+│ 前缀）/ 无序列表（•）；行内沿用 mdInline。仅产 SGR（净化白名单放行）。
 *  超过 maxLines 行截断并给计数提示行（时间线/subagent 视图都是虚拟窗口，行数安全）。 */
export function mdBlock(text: string, maxLines = 60): string[] {
  const ESC = String.fromCharCode(27)
  const DIM = `${ESC}[2m`
  const BOLD = `${ESC}[1m`
  const OFF = `${ESC}[22m`
  const out: string[] = []
  let inCode = false
  const src = text.split('\n')
  for (const raw of src) {
    if (out.length >= maxLines) {
      out.push(`${DIM}⋯ 还有 ${src.length - maxLines} 行${OFF}`)
      return out
    }
    if (/^\s*```/.test(raw)) {
      inCode = !inCode
      out.push(`${DIM}${raw.trim()}${OFF}`)
      continue
    }
    if (inCode) {
      out.push(`  ${DIM}${raw}${OFF}`)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw)
    if (heading !== null) {
      out.push(`${BOLD}${heading[1]}${OFF}`)
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote !== null) {
      out.push(`${DIM}│ ${quote[1]}${OFF}`)
      continue
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw)
    if (bullet !== null) {
      out.push(`${bullet[1]}• ${mdInline(bullet[2])}`)
      continue
    }
    out.push(mdInline(raw))
  }
  return out
}

/** 列出可查看的子代理 transcript 文件（id + mtime + 首行摘要，新→旧）。
 *  F-26：裸 id 无可读性——逐文件读首 2KB 抽首条 user 文本做摘要；时间取文件 mtime。
 *  无项目归属标记（transcript 只含消息行），扫描范围=全部文件但列表只显示最近 maxShow 条
 *  （调用方截断）——避免跨项目历史条目刷屏。 */
export function listSubagentTranscripts(maxShow = 30, currentSid?: string): Array<{ id: string; mtimeMs: number; summary: string }> {
  try {
    // 清账 III P2-3（F-26 热路径 IO）：先 stat 排序截断，再对入选的 maxShow 条读首 2KB 摘要
    // ——原实现对全部文件先读 2KB 再截断（百级历史文件 = 每次开面板全量读盘）
    // F-49：currentSid 非空时只列当前会话的子代理（meta 行带 sid；旧格式无 sid 的文件
    // 不显示——用户拍板「只想看当前这个对话的」）
    return readdirSync(join(homedir(), '.ecode', 'agents'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = join(homedir(), '.ecode', 'agents', f)
        return { id: f.slice(0, -'.jsonl'.length), mtimeMs: statSync(full).mtimeMs, full }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((e) => ({ ...e, sid: readMetaSid(e.full, e.mtimeMs) }))
      .filter((e) => currentSid === undefined || currentSid === '' || e.sid === currentSid)
      .slice(0, maxShow)
      .map(({ id, mtimeMs, full }) => ({ id, mtimeMs, summary: readFirstUserText(full) }))
  } catch {
    return []
  }
}

/** F-49：读 transcript 首 2KB 抽 meta 行的 sid（无 meta/旧格式返回空串=不匹配过滤）。
 *  审阅 T5：mtime 索引缓存——列表页每秒轮询曾对全部历史文件各读 2KB（百级文件=每秒百次
 *  同步读，正是清账 III P2-3 刚优化掉的模式）；mtime 未变直接命中，只有新/变文件落盘。 */
const metaSidCache = new Map<string, { mtimeMs: number; sid: string }>()
function readMetaSid(file: string, mtimeMs?: number): string {
  let mtime = mtimeMs ?? -1
  if (mtime < 0) {
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      return ''
    }
  }
  const hit = metaSidCache.get(file)
  if (hit !== undefined && hit.mtimeMs === mtime) return hit.sid
  let sid = ''
  try {
    const head = readFileSync(file, 'utf8').slice(0, 2048)
    for (const line of head.split('\n')) {
      if (line.trim() === '') continue
      try {
        const m = JSON.parse(line) as { kind?: string; sid?: string; role?: string }
        if (m.kind === 'meta') {
          sid = m.sid ?? ''
          break
        }
        if (m.role !== undefined) break // 终态 messages 行先于 meta=旧格式
      } catch { /* 非 JSON 行跳过 */ }
    }
  } catch { /* 读失败=无 sid */ }
  if (metaSidCache.size >= 512) {
    const oldest = metaSidCache.keys().next().value
    if (oldest !== undefined) metaSidCache.delete(oldest)
  }
  metaSidCache.set(file, { mtimeMs: mtime, sid })
  return sid
}

/** F-26：transcript 首条 user 文本（读首 2KB 截取——大文件不全量读） */
function readFirstUserText(file: string): string {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 2048)
    for (const line of head.split('\n')) {
      if (line.trim() === '') continue
      try {
        const m = JSON.parse(line) as { role?: string; content?: unknown; kind?: string; description?: string }
        // F-46：meta 事件行（运行期落盘首行）——摘要取 description
        if (m.kind === 'meta' && m.description !== undefined) return firstLine(String(m.description))
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

/** F-48 批 2：alt 全屏 offset 记忆（title → 上次位置；模块级跨面板开关保留。
 *  LRU 封顶 32 对齐 wrapCache 惯例；仅 alt 模式写入——嵌入式面板无记忆需求） */
const offsetMemo = new Map<string, number>()
const OFFSET_MEMO_MAX = 32
function memoOffset(key: string, value: number): void {
  if (offsetMemo.size >= OFFSET_MEMO_MAX && !offsetMemo.has(key)) {
    const oldest = offsetMemo.keys().next().value
    if (oldest !== undefined) offsetMemo.delete(oldest)
  }
  // 审阅 P2：先 delete 再 set——Map 已有键 set 不改迭代序，原名 LRU 实为 FIFO
  offsetMemo.delete(key)
  offsetMemo.set(key, value)
}


interface OutputViewerProps {
  title: string
  source: LineSource
  /** 返回列表页（Esc 逐级回退） */
  onBack: () => void
  /** F-48：alt-screen 全屏模式——总帧高恒 rows−2（满屏分支/win32 每帧全清的规避，架构审阅 P0-1），chrome 收起 */
  altMode?: boolean
  /** F-50：l 键打开来源列表（OutputListPage）——时间线内跳转子代理/任务详情 */
  onList?: () => void
}

/** 搜索态：null=未搜索；string=已确认词（n/N 跳转） */
const WHEEL_ACCEL_WINDOW_MS = 200
const WHEEL_ACCEL_STEP = 0.3
const WHEEL_ACCEL_MAX = 6

/** 项 3：时钟可注入（加速窗口判定测试用假时钟；生产恒 Date.now） */
let wheelClock: () => number = () => Date.now()
export function __setWheelClockForTest(fn: () => number): void {
  wheelClock = fn
}

function wheelBaseSpeed(): number {
  const v = Number(process.env.ECODE_SCROLL_SPEED)
  return Number.isFinite(v) && v > 0 ? v : 1
}

export function OutputViewer({ title, source, onBack, altMode, onList }: OutputViewerProps): ReactElement {
  const { budget, rows, columns } = useViewport()
  // F-51：滚轮加速状态（ref 免重渲）；基础倍率=ECODE_SCROLL_SPEED 旋钮（默认 1，
  // 对齐 CC CLAUDE_CODE_SCROLL_SPEED）
  const wheelAccelRef = useRef({ last: 0, dir: 0, mult: wheelBaseSpeed() })
  // 内容窗高度（审阅 P0-2 修正）：帧高账目 = 面板（height + 骨架实占 5：marginTop1+边框2+
  // 标题1+状态1；搜索行出现时 +1）+ App 外部骨架 3（ActivityBar1+输入行1+StatusBar1）
  // ≤ budget（= rows−2，SAFETY_MARGIN 已在其中）。即 height ≤ budget−8；搜索行常驻留量
  // 取 reserve=10——原 6 漏算外部 3 行+吃掉安全余量，任何终端打开都恰满屏触发 3J
  // F-48：alt 全屏帧高账（审阅 P0-1 修正）：chrome 5 + 搜索行留量 1 + 安全余量 1 = 常量 7
  // ——常态帧高 rows−2、搜索打开 rows−1，均 < rows（=rows 即 win32 每帧全清 + 退出 3J
  // 抹主 scrollback；原 rows−6 开搜索恰好 = rows，任何终端确定性触发）。嵌入式模式维持原 reserve=10
  const height = altMode === true
    ? Math.max(3, rows - 7)
    : Math.max(3, sectionBudget(budget, 10))
  const lines = source.lines()
  const total = lines.length
  // F-48 批 2：offset 记忆（alt 全屏，title 为 key）——退出再进恢复上次位置；
  // 恢复记忆位=脱离跟随（follow 仅无记忆的新源/增长源默认开）
  const memoInitial = altMode === true ? offsetMemo.get(title) : undefined
  const [offset, setOffset] = useState(() => {
    if (memoInitial !== undefined) return Math.max(0, Math.min(total - height, memoInitial))
    return Math.max(0, total - height)
  })
  const [followed, setFollowed] = useState(() => (memoInitial === undefined ? source.isGrowing() : false))
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
  // F-48 批 2：offset 记忆写入（alt 全屏；offset/followed 变化即落）——退出面板后再进恢复
  useEffect(() => {
    if (altMode !== true) return
    memoOffset(title, offset)
  }, [altMode, title, offset])

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
      if (key.ctrl && input === 'c') {
        onBack() // 审阅 P2：Ctrl+C 曾被当字符 'c' 追加——面板内 Ctrl+C 恒退出（pager 惯例）
      } else if (key.escape) {
        setSearchInput(null)
      } else if (key.return) {
        setQuery(searchInput)
        setSearchInput(null)
        setFollowed(false)
      } else if (key.backspace || key.delete) {
        setSearchInput((s) => (s === null ? s : s.slice(0, -1)))
      } else if (input !== '' && !isMouseInput(input)) {
        // F-48：SGR 鼠标序列（Ink 透传形态 '[<64;x;yM'）排除在搜索输入外（共享全形态判定）
        setSearchInput((s) => (s ?? '') + input)
      }
      return
    }
    // F-48：滚轮（SGR 64=上滚 65=下滚；只认 M 按下帧）→ 行级滚动
    // F-51：滚轮加速（CC 同款）：基础 1 行/事件（终端每格滚轮本就发对应数量的事件：WT 一格
    // 3 事件=3 行、xterm.js 一格 1 事件），200ms 窗口内连续滚动倍率线性 +0.3 递增至 6；
    // 反向/停手（>200ms）重置。ECODE_SCROLL_SPEED 旋钮调基础倍率。替代批 2 的固定 ±3 拍板值。
    // （审阅 P2：注释曾写 40ms 窗/×1.3 与实现常量不符，已对齐）
    const wheel = /^\[<(\d+);\d+;\d+M$/.exec(input ?? '')
    if (wheel !== null && (Number(wheel[1]) === 64 || Number(wheel[1]) === 65)) {
      const dir = Number(wheel[1]) === 64 ? -1 : 1
      const now = wheelClock()
      const st = wheelAccelRef.current
      if (now - st.last > WHEEL_ACCEL_WINDOW_MS || st.dir !== dir) {
        st.mult = wheelBaseSpeed()
        st.dir = dir
      } else {
        st.mult = Math.min(WHEEL_ACCEL_MAX, st.mult + WHEEL_ACCEL_STEP)
      }
      st.last = now
      if (dir < 0) {
        setFollowed(false)
        setOffset((o) => Math.max(0, o - Math.max(1, Math.floor(st.mult))))
      } else {
        setOffset((o) => Math.min(Math.max(0, total - height), o + Math.max(1, Math.floor(st.mult))))
      }
      return
    }
    // F-48 拍板：面板内 Ctrl+C/q/Esc 均为退出（pager 惯例对齐；中断先退面板再按——
    // 退出后 Ctrl+C 即中断，一次按键成本；避免与中断语义双吃）
    if (key.ctrl && input === 'c' || input === 'q') {
      onBack()
      return
    }
    // F-50：l 打开来源列表（子代理/任务/工具条目级选择）
    if (input === 'l' && onList !== undefined) {
      onList()
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
  // F-50：l 进来源列表（时间线视图内跳转子代理/任务详情）——审阅 P2：仅在 onList 接线时提示
  // （曾是死键恒提示）；整行按显示宽度截断（窄终端 wrap 会再 +1 行叠进帧账）。
  // 项 5：alt 全屏期间鼠标被面板捕获——明示「退出恢复拖选复制」（用户曾困惑复制失效）
  const hint = altMode === true
    ? (onList !== undefined
        ? '↑↓/滚轮 行滚 · /搜索 · l 列表 · Esc 退出（恢复拖选复制）'
        : '↑↓ 行滚 · /搜索 · Esc 退出（恢复拖选复制）')
    : (onList !== undefined
        ? '↑↓ 行滚 · PgUp/PgDn 翻页 · g/G 首尾 · /搜索 · l 列表 · Esc 返回'
        : '↑↓ 行滚 · PgUp/PgDn 翻页 · g/G 首尾 · /搜索 · Esc 返回')
  statusParts.push(clipWidth(hint, Math.max(20, columns - 4)))

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {clipWidth(title, Math.max(20, columns - 4))}
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
  /** F-49：当前会话 id——子代理列表只列本会话（用户拍板「只想看当前这个对话的」） */
  currentSid?: string
  /** F-48：alt-screen 全屏模式 */
  altMode?: boolean
}

export function OutputListPage({ recentTools, onOpen, onExit, altMode, currentSid }: OutputListPageProps): ReactElement {
  // 任务快照 + 轮询（运行中状态实时；F-46：子代理列表同样每次打开面板刷新——
  // 原实现 useState 快照=TuiApp 挂载时一次，本会话新起的子代理永不在列）
  const [tasks, setTasks] = useState(() => taskRegistry.snapshot())
  const [agents, setAgents] = useState(() => listSubagentTranscripts(30, currentSid))
  useEffect(() => {
    const timer = setInterval(() => {
      setTasks(taskRegistry.snapshot())
      setAgents(listSubagentTranscripts(30, currentSid))
    }, 1000)
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
          label: clipWidth(`${mark} ${t.id} ${stripUntrustedAnsi(t.command)}（${t.status}${t.exitCode !== null ? ` exit ${t.exitCode}` : ''}）`, max),
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
          label: clipWidth(`${tool.isError ? '✗' : '·'} ${tool.name} ${stripUntrustedAnsi(preview)}${tool.truncated === true ? ' 〔已截断〕' : ''}`, max),
        })
      }
    }
    if (agents.length > 0) {
      // F-49 后列表已按 currentSid 过滤（非跨项目）——审阅 P2：标签与 slice 对齐（曾写
      // 「跨项目最近 30 条」实显 10 条）；PanelShell 窗口化渲染，全量列出即可
      out.push({ type: 'header', label: '子代理 transcript（本会话）' })
      for (const a of agents) {
        // F-26：裸 id → 时间 + 首行摘要（历史条目不再是一串无意义 id）
        const t = new Date(a.mtimeMs)
        const pad = (n: number): string => String(n).padStart(2, '0')
        const when = `${t.getMonth() + 1}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
        // F-46e：◉ 运行中 / ○ 已完成标记 + id 尾段——并发多个子代理时可区分哪个是哪个
        const mark = isAgentActive(a.id) ? '◉' : '○'
        const idTail = a.id.length > 4 ? a.id.slice(-4) : a.id
        const sum = a.summary === '' ? a.id : a.summary
        out.push({ type: 'item', value: { kind: 'agent', id: a.id }, label: clipWidth(`§${mark} ${when} ${sum} (${idTail})`, max) })
      }
    }
    return out
  }, [tasks, recentTools, agents, columns])

  return (
    <PanelShell
      title="输出查看"
      subtitle="Enter 查看全文 · 运行中任务实时跟随"
      rows={rows}
      onPick={onOpen}
      onCancel={onExit}
      emptyHint="暂无可查看的输出（工具调用/后台任务/子代理）"
      keyHints={altMode === true ? '↑↓ 选择 · 回车 查看 · q/Esc 退出（恢复拖选复制）' : '↑↓ 选择 · 回车 查看 · Esc 返回'}
    />
  )
}
