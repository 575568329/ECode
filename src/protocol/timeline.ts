/**
 * 轮内时间线归约（活动流 B3，详设 v1.7 §3）：
 * 协议帧 → TurnTimeline 的纯函数收口——TUI 与 web 同一实现（web 独立包可 import 不拖 Ink，
 * 双份实现必漂移）。TuiApp/web store 只做帧转发。
 *
 * 实现锚（v1.7 渲染审阅 P1-2）：**append-only + 按 id 原位换新对象、未动条目对象恒等**——
 * 这是条目级 React.memo 生效的前提（web EntryRow 先例）。
 *
 * 分段机理：item/started（流式 block start 时机）是 text 分段的唯一封口信号——
 * [text1, toolA, text2] 中 text1+text2 不黏连（与 transcript content blocks 同源，
 * 轮末 pullTranscript 重建结果天然一致，跳变根治）。
 *
 * 净化层次（v1.7 管线审阅 P2-3）：本模块不 import tui/sanitize——delta 的流式净化
 * （streamStripper）留在 TuiApp 接线层（delta → stripper.push → reducer）；
 * thinking 段存原文（transcript 保真），渲染口无状态 strip。web 侧 React 渲染无需 stripper。
 */
import type { ProtocolEvent } from './types.js'

/** 时间线工具条目（ActiveTool 的协议投影——use 保持 unknown，客户端侧再窄化） */
export interface TimelineTool {
  name: string
  /** 真实 tool_use id（itemId 同源修复后 started/completed/executing 三帧同 id 闭环） */
  id: string
  /** item/executing 帧回填（loading 行与运行行「正在执行 <命令>」的数据源） */
  digest?: string
  /** completed 帧回填（ToolUseBlock 形状） */
  use?: unknown
  content?: string
  isError?: boolean
  truncated?: boolean
  status: 'running' | 'done' | 'error'
  at?: number
}

/** 轮内时间线条目：按事件到达序 append，永不重排 */
export type TimelineEntry =
  | { kind: 'text'; id: string; text: string; live: boolean }
  | { kind: 'thinking'; id: string; blockIndex: number; startedAt: number; endedAt?: number; durMs?: number; text: string }
  | { kind: 'tool'; id: string; tool: TimelineTool }

export interface TimelineReducerDeps {
  /** 时钟注入（测试可控；生产 Date.now） */
  now: () => number
  /** 条目 id 生成器（text 段无协议 id——客户端自增；调用侧持有计数器防 reducer 内状态） */
  nextId: (kind: 'text' | 'thinking' | 'tool') => string
}

function sealLiveTexts(state: TimelineEntry[], deps: TimelineReducerDeps): TimelineEntry[] {
  let changed = false
  const next = state.map((e) => {
    if (e.kind === 'text' && e.live) {
      changed = true
      return { ...e, live: false }
    }
    return e
  })
  void deps
  return changed ? next : state
}

/**
 * 单帧归约。返回新数组（未动条目引用恒等）；封口/回填均原位换新对象。
 * 旧宿主容错：completed 无 id 匹配 → append 终态条目（TuiApp `else tools.push` 兜底语义）。
 */
export function timelineReducer(state: TimelineEntry[], ev: ProtocolEvent, deps: TimelineReducerDeps): TimelineEntry[] {
  switch (ev.type) {
    case 'delta': {
      const last = state[state.length - 1]
      if (last !== undefined && last.kind === 'text' && last.live) {
        const next = state.slice()
        next[next.length - 1] = { ...last, text: last.text + ev.text }
        return next
      }
      return [...state, { kind: 'text', id: deps.nextId('text'), text: ev.text, live: true }]
    }
    case 'thinking': {
      const idx = state.findIndex((e) => e.kind === 'thinking' && e.blockIndex === ev.blockIndex && e.endedAt === undefined)
      if (idx >= 0) {
        const hit = state[idx] as Extract<TimelineEntry, { kind: 'thinking' }>
        const next = state.slice()
        next[idx] = { ...hit, text: hit.text + ev.text }
        return next
      }
      return [...state, { kind: 'thinking', id: deps.nextId('thinking'), blockIndex: ev.blockIndex, startedAt: deps.now(), text: ev.text }]
    }
    case 'thinking/ended': {
      const idx = state.findIndex((e) => e.kind === 'thinking' && e.blockIndex === ev.blockIndex && e.endedAt === undefined)
      if (idx < 0) return state
      const hit = state[idx] as Extract<TimelineEntry, { kind: 'thinking' }>
      const next = state.slice()
      next[idx] = { ...hit, endedAt: deps.now(), durMs: ev.durMs }
      return next
    }
    case 'item/started': {
      // text 分段唯一封口信号（B1 保持流式时机的根由）
      const sealed = sealLiveTexts(state, deps)
      return [...sealed, { kind: 'tool', id: ev.itemId, tool: { name: ev.name, id: ev.itemId, status: 'running', at: deps.now() } }]
    }
    case 'item/executing': {
      const idx = state.findIndex((e) => e.kind === 'tool' && e.tool.id === ev.itemId)
      if (idx < 0) return state
      const hit = state[idx] as Extract<TimelineEntry, { kind: 'tool' }>
      const next = state.slice()
      next[idx] = { ...hit, tool: { ...hit.tool, digest: ev.digest } }
      return next
    }
    case 'item/completed': {
      const done: TimelineTool = {
        name: ev.name,
        id: ev.itemId,
        content: ev.content,
        isError: ev.isError,
        ...(ev.truncated === true ? { truncated: true } : {}),
        ...(ev.use !== undefined ? { use: ev.use } : {}),
        status: ev.isError ? 'error' : 'done',
      }
      const idx = state.findIndex((e) => e.kind === 'tool' && e.tool.id === ev.itemId)
      if (idx >= 0) {
        const hit = state[idx] as Extract<TimelineEntry, { kind: 'tool' }>
        const next = state.slice()
        // 原位保留 started 时刻/digest（终态回填不丢运行痕迹）
        next[idx] = { ...hit, tool: { ...hit.tool, ...done, digest: hit.tool.digest } }
        return next
      }
      // 旧宿主兜底：started 未达（或 id 不同源的老帧）——直接 append 终态
      return [...state, { kind: 'tool', id: ev.itemId, tool: done }]
    }
    case 'turn/completed':
    case 'error': {
      // 全部 live 段封口（error 轮无 completed 帧的兜底）
      return sealLiveTexts(state, deps)
    }
    default:
      return state
  }
}

/** 条目 id 计数器工厂（调用侧持有；reducer 无内部状态） */
export function makeTimelineIdFactory(): { nextId: (kind: 'text' | 'thinking' | 'tool') => string } {
  let seq = 0
  return { nextId: (kind) => `${kind}-${++seq}` }
}
