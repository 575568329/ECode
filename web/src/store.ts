/**
 * M13-W5 客户端状态（Zustand 单 store——服务端权威、前端仅渲染态）。
 * W5 骨架范围：连接状态/项目列表/会话 brief（baseline 与实时帧驱动）/当前选中。
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

interface AppState {
  connState: 'connecting' | 'open' | 'backoff'
  projects: string[] // 三源并集（registered ∪ active ∪ history——App 加载时拉一次 + mux 帧增删）
  sessions: SessionBrief[]
  selectedProject: string | null
  selectedSession: string | null
  // 帧
  applyHost: (h: HostEventFrame['host']) => void
  applyFrame: (f: MuxFrame) => void
  setConn: (s: 'connecting' | 'open' | 'backoff') => void
  setProjects: (ps: string[]) => void
  select: (project: string | null, session: string | null) => void
  upsertSession: (b: SessionBrief) => void
}

export const useApp = create<AppState>((set) => ({
  connState: 'connecting',
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSession: null,
  setConn: (connState) => set({ connState }),
  setProjects: (projects) => set({ projects }),
  select: (selectedProject, selectedSession) => set({ selectedProject, selectedSession }),
  upsertSession: (b) =>
    set((st) => {
      const i = st.sessions.findIndex((s) => s.sessionId === b.sessionId)
      const sessions = i === -1 ? [...st.sessions, b] : st.sessions.map((s, j) => (j === i ? b : s))
      return { sessions }
    }),
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
        case 'session/removed': {
          const target = st.sessions.find((s) => s.sessionId === h.sessionId)
          void target
          return { sessions: st.sessions.filter((s) => s.sessionId !== h.sessionId) }
        }
        default:
          return st
      }
    }),
  applyFrame: (f) => {
    // W5：running 态翻新（thread/status 驱动 brief.running；其余事件 W6a 消费）
    if (f.ev.type === 'thread/status') {
      const busy = f.ev.busy === true
      set((st) => ({
        sessions: st.sessions.map((s) => (s.sessionId === f.sessionId && s.project === f.project ? { ...s, running: busy } : s)),
      }))
    }
  },
}))
