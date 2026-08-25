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

/** 单条渲染消息（历史补拉与流式共用形） */
export interface ChatEntry {
  kind: 'user' | 'assistant' | 'system'
  text: string
}

export interface SessionView {
  entries: ChatEntry[]
  items: ToolItem[]
  /** 流式缓冲（当前轮 assistant 增量——turn/completed 时并入 entries 清空） */
  streaming: string
  queue: string[]
  loaded: boolean
}

const emptyView = (): SessionView => ({ entries: [], items: [], streaming: '', queue: [], loaded: false })

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
  /** W6a：历史补拉（session/read 返回的 HistoryLine 投影为 entries） */
  loadHistory: (sessionId: string, lines: unknown) => void
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
        const entries: ChatEntry[] = []
        for (const l of lines as Array<Record<string, unknown>>) {
          if (typeof l !== 'object' || l === null || !('role' in l)) continue // 边界/rewind/统计行跳过
          const role = l.role as string
          const content = Array.isArray(l.content) ? (l.content as Array<{ type: string; text?: string }>) : []
          const text = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('')
          if (text === '') continue
          if (role === 'user') entries.push({ kind: 'user', text })
          else if (role === 'assistant') entries.push({ kind: 'assistant', text })
        }
        return { ...v, entries, loaded: true }
      }),
    ),
  applyHost: (h) =>
    set((st) => {
      switch (h.type) {
        case 'session/baseline':
          return {
            projects: [...new Set([...st.projects, ...h.projects])],
            sessions: h.sessions,
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
        default:
          return st
      }
    })
  },
}))
