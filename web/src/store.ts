/**
 * M13 客户端状态（Zustand 单 store——服务端权威、前端仅渲染态）。
 * W5：连接/项目/会话 brief/选中。W6a：per-session 消息视图（流式 delta/工具卡/队列预览）。
 */

import { create } from 'zustand'
import type { HostEventFrame, MuxFrame } from './connect'

export interface SessionBrief {
  project: string
  sessionId: string
  running: boolean
  title: string
  updatedAt: number
}

/** 工具卡（item/started→running；item/completed→终态带摘要与可展开内容） */
export interface ToolItem {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  summary?: string
  content?: string
}

/** 单条渲染消息（历史补拉与流式共用形；tool=历史工具调用投影——tool_use/tool_result 配对） */
export interface ChatEntry {
  kind: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  name?: string
  ok?: boolean
}

export interface SessionView {
  entries: ChatEntry[]
  items: ToolItem[]
  /** 流式缓冲（当前轮 assistant 增量——turn/completed 时并入 entries 清空） */
  streaming: string
  queue: string[]
  loaded: boolean
  /** 历史补拉失败原因（''=无；Conversation 顶部红条 + 重试） */
  loadError: string
  /** W6b：挂起审批（approval/requested 帧——composer-takeover 渲染） */
  approval: { requestId: string; kind?: string; tool: string; preview: string; decisions: string[] } | null
  /** W6b：挂起单选（askSelect/requested 帧） */
  askSelect: { requestId: string; title: string; options: string[] } | null
}

export const emptyView = (): SessionView => ({ entries: [], items: [], streaming: '', queue: [], loaded: false, loadError: '', approval: null, askSelect: null })

interface AppState {
  connState: 'connecting' | 'open' | 'backoff'
  projects: string[]
  sessions: SessionBrief[]
  selectedProject: string | null
  selectedSession: string | null
  /** W6a：per-session 视图（key=sessionId——mux 帧按 sessionId 分发） */
  views: Record<string, SessionView>
  applyHost: (h: HostEventFrame['host']) => void
  applyFrame: (f: MuxFrame) => void
  setConn: (s: 'connecting' | 'open' | 'backoff') => void
  setProjects: (ps: string[]) => void
  select: (project: string | null, session: string | null) => void
  upsertSession: (b: SessionBrief) => void
  /** W6a：历史补拉（session/read 返回的 HistoryLine 投影为 entries——含工具调用配对投影） */
  loadHistory: (sessionId: string, lines: unknown) => void
  /** 补拉失败标记（顶部红条 + 重试入口）；retryLoad 清标记并重置 loaded 触发重拉 */
  setLoadError: (sessionId: string, msg: string) => void
  retryLoad: (sessionId: string) => void
  /** 发送成功即时上屏 user 消息（当前轮 user 不经任何帧回推——G3 实测缺口） */
  appendUser: (sessionId: string, text: string) => void
}

const patchView = (state: AppState, sessionId: string, patch: (v: SessionView) => SessionView): Partial<AppState> => ({
  views: { ...state.views, [sessionId]: patch(state.views[sessionId] ?? emptyView()) },
})

export const useApp = create<AppState>((set) => ({
  connState: 'connecting',
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSession: null,
  views: {},
  setConn: (connState) => set({ connState }),
  setProjects: (projects) => set({ projects }),
  select: (selectedProject, selectedSession) => set({ selectedProject, selectedSession }),
  upsertSession: (b) =>
    set((st) => {
      const i = st.sessions.findIndex((s) => s.sessionId === b.sessionId)
      const sessions = i === -1 ? [...st.sessions, b] : st.sessions.map((s, j) => (j === i ? b : s))
      return { sessions }
    }),
  loadHistory: (sessionId, lines) =>
    set((st) =>
      patchView(st, sessionId, (v) => {
        if (!Array.isArray(lines)) return { ...v, loaded: true }
        // 两遍投影：先收 tool_use_id → result（成败/摘要），再按序出 entry——历史轮的工具调用
        // 不再被丢弃（G3 挂账：此前只投影 text 块，恢复会话看不到当时干了什么）
        const results = new Map<string, { ok: boolean; summary: string }>()
        for (const l of lines as Array<Record<string, unknown>>) {
          if (typeof l !== 'object' || l === null || l.role !== 'user' || !Array.isArray(l.content)) continue
          for (const b of l.content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              const content = typeof b.content === 'string' ? b.content : ''
              results.set(b.tool_use_id, { ok: b.is_error !== true, summary: content.split('\n')[0]?.slice(0, 80) ?? '' })
            }
          }
        }
        const entries: ChatEntry[] = []
        for (const l of lines as Array<Record<string, unknown>>) {
          if (typeof l !== 'object' || l === null || !('role' in l)) continue // 边界/rewind/统计行跳过
          const role = l.role as string
          const content = Array.isArray(l.content) ? (l.content as Array<Record<string, unknown>>) : []
          const text = content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
          if (role === 'user') {
            if (text !== '') entries.push({ kind: 'user', text })
          } else if (role === 'assistant') {
            if (text !== '') entries.push({ kind: 'assistant', text })
            for (const b of content) {
              if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
              const r = results.get(String(b.id ?? ''))
              entries.push({ kind: 'tool', text: r?.summary ?? '', name: b.name, ok: r?.ok ?? true })
            }
          }
        }
        return { ...v, entries, loaded: true, loadError: '' }
      }),
    ),
  setLoadError: (sessionId, msg) => set((st) => patchView(st, sessionId, (v) => ({ ...v, loaded: true, loadError: msg }))),
  retryLoad: (sessionId) => set((st) => patchView(st, sessionId, (v) => ({ ...v, loaded: false, loadError: '' }))),
  appendUser: (sessionId, text) =>
    set((st) =>
      patchView(st, sessionId, (v) => ({
        ...v,
        entries: [...v.entries, { kind: 'user' as const, text }],
      })),
    ),
  applyHost: (h) =>
    set((st) => {
      switch (h.type) {
        case 'session/baseline':
          // 按会话订阅的 baseline 只含订阅会话的 brief——合并而非整体替换
          // （替换会洗掉列表里其他会话；G3 实测）
          return {
            projects: [...new Set([...st.projects, ...h.projects])],
            sessions: [
              ...h.sessions,
              ...st.sessions.filter((s) => !h.sessions.some((b) => b.sessionId === s.sessionId)),
            ],
          }
        case 'project/added':
          return { projects: [...new Set([...st.projects, h.project])] }
        case 'project/removed':
          return {
            projects: st.projects.filter((p) => p !== h.project),
            sessions: st.sessions.filter((s) => s.project !== h.project),
          }
        case 'session/created':
          return { sessions: st.sessions.some((s) => s.sessionId === h.brief.sessionId) ? st.sessions : [...st.sessions, h.brief] }
        case 'session/removed':
          return { sessions: st.sessions.filter((s) => s.sessionId !== h.sessionId) }
        default:
          return st
      }
    }),
  applyFrame: (f) => {
    set((st) => {
      // 会话级 running 翻新
      if (f.ev.type === 'thread/status') {
        const busy = f.ev.busy === true
        const sessions = st.sessions.map((s) => (s.sessionId === f.sessionId && s.project === f.project ? { ...s, running: busy } : s))
        return { ...st, sessions }
      }
      switch (f.ev.type) {
        case 'delta':
          return patchView(st, f.sessionId, (v) => ({ ...v, streaming: v.streaming + String(f.ev.text ?? '') }))
        case 'item/started':
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            items: [...v.items, { id: String(f.ev.itemId ?? ''), name: String(f.ev.name ?? ''), status: 'running' }],
          }))
        case 'item/completed': {
          const id = String(f.ev.itemId ?? '')
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            items: v.items.map((it) => (it.id === id ? { ...it, status: f.ev.isError === true ? 'error' : 'done', summary: String(f.ev.summary ?? ''), content: String(f.ev.content ?? '') } : it)),
          }))
        }
        case 'turn/completed':
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            entries: v.streaming === '' ? v.entries : [...v.entries, { kind: 'assistant', text: v.streaming }],
            streaming: '',
          }))
        case 'queue/snapshot':
          return patchView(st, f.sessionId, (v) => ({ ...v, queue: Array.isArray(f.ev.items) ? (f.ev.items as string[]) : [] }))
        case 'session/clear':
          // 宿主权威 clear——本地视图同步清
          return patchView(st, f.sessionId, () => emptyView())
        case 'approval/requested':
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            approval: {
              requestId: String(f.ev.requestId ?? ''),
              kind: f.ev.kind === undefined ? undefined : String(f.ev.kind),
              tool: String(f.ev.tool ?? ''),
              preview: String(f.ev.preview ?? ''),
              decisions: Array.isArray(f.ev.decisions) ? (f.ev.decisions as string[]) : ['once', 'reject'],
            },
          }))
        case 'approval/resolved':
          return patchView(st, f.sessionId, (v) => (v.approval !== null && v.approval.requestId === String(f.ev.requestId ?? '') ? { ...v, approval: null } : v))
        case 'askSelect/requested':
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            askSelect: { requestId: String(f.ev.requestId ?? ''), title: String(f.ev.title ?? ''), options: Array.isArray(f.ev.options) ? (f.ev.options as string[]) : [] },
          }))
        case 'askSelect/resolved':
          return patchView(st, f.sessionId, (v) => (v.askSelect !== null && v.askSelect.requestId === String(f.ev.requestId ?? '') ? { ...v, askSelect: null } : v))
        default:
          return st
      }
    })
  },
}))
