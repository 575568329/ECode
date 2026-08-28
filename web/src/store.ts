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

/** 工具卡（item/started→running；item/completed→终态带摘要与可展开内容）。
 *  truncated=帧内 content 已被宿主 4KB 截断（C1⑤）；fullLoaded=item/read 补全完成 */
export interface ToolItem {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  summary?: string
  content?: string
  truncated?: boolean
  fullLoaded?: boolean
}

/** 内联图片（data URI 直渲——session/read 恢复形态里 image_ref 已被宿主转回 base64 ImageBlock） */
export interface ChatImage {
  mediaType: string
  data: string
}

/** 单条渲染消息（历史补拉与流式共用形；tool=历史工具调用投影——tool_use/tool_result 配对） */
export interface ChatEntry {
  kind: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  name?: string
  ok?: boolean
  /** user 消息携带图 / tool_result 附着图（read_file 读图） */
  images?: ChatImage[]
  /** system 行的失败标记（error 帧红显；systemMsg/notice 灰显） */
  error?: boolean
}

/** askUser 题（宿主 AskUserQuestion 投影——web 从简为「点选填入 + 自由文本」） */
export interface AskUserQuestionView {
  question: string
  header: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
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
  /** W6b：挂起审批（approval/requested 帧——composer-takeover 渲染）；claimedBy=他端已认领（advisory） */
  approval: { requestId: string; kind?: string; tool: string; preview: string; decisions: string[]; claimedBy?: string } | null
  /** W6b：挂起单选（askSelect/requested 帧） */
  askSelect: { requestId: string; title: string; options: string[] } | null
  /** C4-③：挂起自由文本问答（askUser/requested 帧——表单 takeover） */
  askUser: { requestId: string; questions: AskUserQuestionView[] } | null}

export const emptyView = (): SessionView => ({ entries: [], items: [], streaming: '', queue: [], loaded: false, loadError: '', approval: null, askSelect: null, askUser: null })

/** 模型视图（config/get 脱敏回执投影——顶栏只看 current + 各 provider 可选模型） */
export interface ConfigView {
  currentName: string
  currentModel: string
  modelsByProvider: Record<string, string[]>
}

/** redact 后的 config 对象（apiKey 已是掩码，不读）→ 顶栏需要的窄视图 */
export function toConfigView(raw: unknown): ConfigView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const cfg = raw as { current?: { name?: unknown; model?: unknown }; providers?: Record<string, { models?: unknown }> }
  if (typeof cfg.current?.name !== 'string' || typeof cfg.current.model !== 'string' || typeof cfg.providers !== 'object') return null
  const modelsByProvider: Record<string, string[]> = {}
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (Array.isArray(p.models)) modelsByProvider[name] = p.models.filter((m): m is string => typeof m === 'string')
  }
  return { currentName: cfg.current.name, currentModel: cfg.current.model, modelsByProvider }
}

interface AppState {
  connState: 'connecting' | 'open' | 'backoff'
  projects: string[]
  sessions: SessionBrief[]
  selectedProject: string | null
  selectedSession: string | null
  /** W6a：per-session 视图（key=sessionId——mux 帧按 sessionId 分发） */
  views: Record<string, SessionView>
  /** W9 顶栏：当前模型视图（config/get 初载 + config/changed 增量——任一会话切了模型全端同步） */
  configView: ConfigView
  applyHost: (h: HostEventFrame['host']) => void
  applyFrame: (f: MuxFrame) => void
  setConn: (s: 'connecting' | 'open' | 'backoff') => void
  setProjects: (ps: string[]) => void
  select: (project: string | null, session: string | null) => void
  upsertSession: (b: SessionBrief) => void
  setConfigView: (c: ConfigView) => void
  /** W6a：历史补拉（session/read 返回的 HistoryLine 投影为 entries——含工具调用配对投影） */
  loadHistory: (sessionId: string, lines: unknown) => void
  /** 补拉失败标记（顶部红条 + 重试入口）；retryLoad 清标记并重置 loaded 触发重拉 */
  setLoadError: (sessionId: string, msg: string) => void
  retryLoad: (sessionId: string) => void
  /** 发送成功即时上屏 user 消息（当前轮 user 不经任何帧回推——G3 实测缺口） */
  appendUser: (sessionId: string, text: string) => void
  /** C1⑤ 补漏：item/read 全文补全落卡（截断帧展开时拉取——避免每次渲染重复拉） */
  completeTool: (sessionId: string, itemId: string, content: string) => void
}

const patchView = (state: AppState, sessionId: string, patch: (v: SessionView) => SessionView): Partial<AppState> => ({
  views: { ...state.views, [sessionId]: patch(state.views[sessionId] ?? emptyView()) },
})

/** 图片块提取（ImageBlock.source.base64 → ChatImage；非 image/非 base64 块跳过） */
function pickImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return []
  const out: ChatImage[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type !== 'image') continue
    const src = b.source as { type?: string; media_type?: string; data?: string } | undefined
    if (src !== undefined && src.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
      out.push({ mediaType: src.media_type, data: src.data })
    }
  }
  return out
}

export const useApp = create<AppState>((set) => ({
  connState: 'connecting',
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSession: null,
  views: {},
  configView: { currentName: '', currentModel: '', modelsByProvider: {} },
  setConn: (connState) => set({ connState }),
  setProjects: (projects) => set({ projects }),
  select: (selectedProject, selectedSession) => set({ selectedProject, selectedSession }),
  setConfigView: (configView) => set({ configView }),
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
        // 两遍投影：先收 tool_use_id → result（成败/摘要/附着图），再按序出 entry——历史轮的工具调用
        // 不再被丢弃（G3 挂账：此前只投影 text 块，恢复会话看不到当时干了什么）
        const results = new Map<string, { ok: boolean; summary: string; images: ChatImage[] }>()
        for (const l of lines as Array<Record<string, unknown>>) {
          if (typeof l !== 'object' || l === null || l.role !== 'user' || !Array.isArray(l.content)) continue
          for (const b of l.content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              const content = typeof b.content === 'string' ? b.content : ''
              results.set(b.tool_use_id, { ok: b.is_error !== true, summary: content.split('\n')[0]?.slice(0, 80) ?? '', images: pickImages(b.blocks) })
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
            const images = pickImages(content)
            if (text !== '' || images.length > 0) entries.push({ kind: 'user', text, ...(images.length > 0 ? { images } : {}) })
          } else if (role === 'assistant') {
            if (text !== '') entries.push({ kind: 'assistant', text })
            for (const b of content) {
              if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
              const r = results.get(String(b.id ?? ''))
              entries.push({ kind: 'tool', text: r?.summary ?? '', name: b.name, ok: r?.ok ?? true, ...(r !== undefined && r.images.length > 0 ? { images: r.images } : {}) })
            }
          }
        }
        // 补拉落定与流式 delta 竞态（审阅 P1-10）：session/read 快照若早于已到的增量，
        // 直接清 streaming 会丢字——把缓冲并入 entries 尾部再清
        const tail = v.streaming !== '' ? [{ kind: 'assistant' as const, text: v.streaming }] : []
        return { ...v, entries: [...entries, ...tail], loaded: true, loadError: '', streaming: '', items: [], queue: [] }
      }),
    ),
  setLoadError: (sessionId, msg) => set((st) => patchView(st, sessionId, (v) => ({ ...v, loaded: true, loadError: msg }))),  retryLoad: (sessionId) => set((st) => patchView(st, sessionId, (v) => ({ ...v, loaded: false, loadError: '' }))),
  appendUser: (sessionId, text) =>
    set((st) =>
      patchView(st, sessionId, (v) => ({
        ...v,
        entries: [...v.entries, { kind: 'user' as const, text }],
      })),
    ),
  completeTool: (sessionId, itemId, content) =>
    set((st) =>
      patchView(st, sessionId, (v) => ({
        ...v,
        items: v.items.map((it) => (it.id === itemId ? { ...it, content, truncated: false, fullLoaded: true } : it)),
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
        case 'config/changed': {
          // 顶栏模型视图同步——只认当前选中项目的帧（每项目独立 current，别项目切换不应刷掉本屏）
          if (st.selectedProject !== null && f.project !== st.selectedProject) return st
          const v = toConfigView(f.ev.config)
          return v !== null ? { configView: v } : st
        }
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
            items: v.items.map((it) => (it.id === id ? { ...it, status: f.ev.isError === true ? 'error' : 'done', summary: String(f.ev.summary ?? ''), content: String(f.ev.content ?? ''), truncated: f.ev.truncated === true } : it)),
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
        case 'approval/claimed':
          // C2⑤ 补账（advisory）：他端认领——本端按钮降权提示（先答先得权威不变，仍可答）
          return patchView(st, f.sessionId, (v) =>
            v.approval !== null && v.approval.requestId === String(f.ev.requestId ?? '')
              ? { ...v, approval: { ...v.approval, claimedBy: String(f.ev.claimant ?? '他端') } }
              : v,
          )
        case 'approval/resolved':
          return patchView(st, f.sessionId, (v) => (v.approval !== null && v.approval.requestId === String(f.ev.requestId ?? '') ? { ...v, approval: null } : v))
        case 'askSelect/requested':
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            askSelect: { requestId: String(f.ev.requestId ?? ''), title: String(f.ev.title ?? ''), options: Array.isArray(f.ev.options) ? (f.ev.options as string[]) : [] },
          }))
        case 'askSelect/resolved':
          return patchView(st, f.sessionId, (v) => (v.askSelect !== null && v.askSelect.requestId === String(f.ev.requestId ?? '') ? { ...v, askSelect: null } : v))
        case 'askUser/requested': {
          // C4-③：自由文本问答（questions 投影防御——unknown[] 逐字段收窄）
          const raw = Array.isArray(f.ev.questions) ? (f.ev.questions as Array<Record<string, unknown>>) : []
          const questions: AskUserQuestionView[] = raw
            .filter((q) => typeof q?.question === 'string')
            .map((q) => ({
              question: String(q.question),
              header: typeof q.header === 'string' ? q.header : '',
              options: Array.isArray(q.options)
                ? (q.options as Array<Record<string, unknown>>).filter((o) => typeof o?.label === 'string').map((o) => ({ label: String(o.label), ...(typeof o.description === 'string' ? { description: o.description } : {}) }))
                : [],
              ...(q.multiSelect === true ? { multiSelect: true } : {}),
            }))
          return patchView(st, f.sessionId, (v) => ({ ...v, askUser: { requestId: String(f.ev.requestId ?? ''), questions } }))
        }
        case 'askUser/resolved':
          return patchView(st, f.sessionId, (v) => (v.askUser !== null && v.askUser.requestId === String(f.ev.requestId ?? '') ? { ...v, askUser: null } : v))
        // C4-②：error/systemMsg/notice 帧此前全丢弃——轮次失败表现为「没下文」；
        // 入对话流 system 行（error 红显），移动端同等可见
        case 'error':
          return patchView(st, f.sessionId, (v) => ({ ...v, entries: [...v.entries, { kind: 'system', text: String(f.ev.message ?? ''), error: true }] }))
        case 'systemMsg':
          return patchView(st, f.sessionId, (v) => ({ ...v, entries: [...v.entries, { kind: 'system', text: String(f.ev.text ?? '') }] }))
        case 'notice':
          return patchView(st, f.sessionId, (v) => ({
            ...v,
            entries: [...v.entries, { kind: 'system', text: `${f.ev.level === 'error' ? '✖' : f.ev.level === 'warn' ? '⚠' : 'ℹ'} ${String(f.ev.text ?? '')}`, ...(f.ev.level === 'error' ? { error: true } : {}) }],
          }))
        default:
          return st
      }
    })
  },
}))
