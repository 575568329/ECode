/**
 * M13-W5 骨架页：token 门 → 两级列表（项目 → 会话）+ 连接状态条。
 * W8 布局批（harness 同款 AppFrame 形）：主列 = 滚动体（hero/对话）+ 常驻底部输入区
 * （session-optional——未选项目禁用占位、hero 态输入即开新对话）；侧栏可添加项目。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Archive, BarChart3, ChevronDown, Pencil, Plus, Search } from 'lucide-react'
import { groupSessionsByTime, searchSessions, type SidebarSession } from './sessionList'
import { lastSeqFor } from './store'
import { addProject, connectMux, fetchProjects, getToken, setToken, sendCommand, type MuxConnection } from './connect'
import { toConfigView, useApp } from './store'
import { makeHash, parseHash, type RoutePos } from './routing'
import { Conversation } from './Conversation'
import { Composer } from './Composer'
import { StatsPanel } from './StatsPanel'

/** 同源定位 daemon（dev 模式经 vite proxy；托管形态同源直连） */
const BASE = ''

function TokenGate({ onReady, hint }: { onReady: () => void; hint?: string }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  return (
    <div className="flex h-full items-center justify-center">
      <form
        className="w-80 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim() === '') return
          setToken(value.trim())
          setError('')
          fetchProjects(BASE)
            .then(() => onReady())
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        }}
      >
        <div className="text-sm text-dim">连接 ECode daemon</div>
        <div className="text-xs text-muted">局域网访问输 serve 启动时设置的密码（ECODE_SERVER_PASSWORD）；本机访问见 ~/.ecode/server.json 的 token</div>
        {hint !== undefined && hint !== '' && <div className="text-xs text-amber-400">⚠ {hint}</div>}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="token / 密码"
          className="w-full rounded border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong"
        />
        {error !== '' && <div className="text-xs text-red-400">{error}</div>}
        <button type="submit" className="w-full rounded bg-neutral-200 px-3 py-2 text-sm font-medium text-canvas">
          连接
        </button>
      </form>
    </div>
  )
}

function ConnBadge(): React.JSX.Element {
  const connState = useApp((s) => s.connState)
  const color = connState === 'open' ? 'bg-emerald-500' : connState === 'connecting' ? 'bg-amber-400' : 'bg-red-500 animate-pulse'
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {connState === 'open' ? '已连接' : connState === 'connecting' ? '连接中' : '重连中'}
    </span>
  )
}

/** 批 2 会话行：状态点 + hover 操作（重命名/归档）。重命名态整行变输入框（Enter 存 / Esc 取消） */
function SessionRow({
  brief,
  active,
  onClick,
  onArchive,
  onRenameStart,
  renameMode,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  brief: { sessionId: string; title: string; running: boolean }
  active: boolean
  onClick: () => void
  onArchive?: () => void
  onRenameStart?: () => void
  renameMode?: boolean
  renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameSubmit?: () => void
  onRenameCancel?: () => void
}): React.JSX.Element {
  if (renameMode) {
    return (
      <div className="px-0.5 py-0.5">
        <input
          autoFocus
          value={renameValue ?? ''}
          onChange={(e) => onRenameChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameSubmit?.()
            if (e.key === 'Escape') onRenameCancel?.()
          }}
          onBlur={() => onRenameCancel?.()}
          className="w-full rounded border border-neutral-600 bg-surface px-2 py-1 text-sm outline-none focus:border-dim"
        />
      </div>
    )
  }
  const dotColor = brief.running ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'
  return (
    <div className={`group flex w-full items-center rounded ${active ? 'bg-surface-raised' : 'hover:bg-surface-raised/60'}`}>
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
        <span className="truncate text-body">{brief.title === '' ? brief.sessionId.slice(-12) : brief.title}</span>
      </button>
      <span className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {onRenameStart !== undefined && (
          <button
            onClick={onRenameStart}
            title="重命名（手动命名即固化标题）"
            className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-neutral-700 hover:text-body"
          >
            <Pencil size={11} />
          </button>
        )}
        {onArchive !== undefined && (
          <button
            onClick={onArchive}
            title="归档（列表隐藏，可从「已归档」恢复）"
            className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-neutral-700 hover:text-body"
          >
            <Archive size={11} />
          </button>
        )}
      </span>
    </div>
  )
}

/** W7：软键盘视口跟随（iOS visualViewport）。本组件只负责把 vv.height 写进 --vvh 变量；
 * 高度统一在根上消费（index.css：html/body/#root = var(--vvh, 100%)）。包裹层自身不得再钉
 * var(--vvh) 高度——它在 flex 列里以整窗高作 basis，会把上方 flex-1 滚动体挤成一条缝
 * （桌面实测：main 981px 中对话区仅剩 24px，历史会话只露出底部一行——2026-08-29 布局塌陷修复） */
function KeyboardAware({ children }: { children: React.ReactNode }): React.JSX.Element {
  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    const onResize = (): void => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`)
    }
    vv.addEventListener('resize', onResize)
    onResize()
    return () => vv.removeEventListener('resize', onResize)
  }, [])
  return <div>{children}</div>
}

/** W9 顶栏模型芯片：显示当前 model，下拉列出当前 provider 的可选模型，选中发 model/set
 * （宿主改活引用 current + config/changed 广播——全端同步；model/set 经缺省路由到项目默认会话） */
function ModelChip(): React.JSX.Element {
  const cv = useApp((s) => s.configView)
  const project = useApp((s) => s.selectedProject) // 缺省路由会落到 serve 启动目录——必须显式带选中项目
  const [open, setOpen] = useState(false)
  const models = cv.modelsByProvider[cv.currentName] ?? []
  const pick = (m: string): void => {
    setOpen(false)
    if (m !== cv.currentModel && project !== null) {
      void sendCommand('', project, undefined, { op: 'model/set', provider: cv.currentName, model: m }).catch(() => {})
    }
  }
  return (
    <span className="relative">
      <button
        onClick={() => models.length > 0 && setOpen(!open)}
        className="flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[11px] text-dim hover:border-line-strong hover:text-bright"
        title={`provider: ${cv.currentName}`}
      >
        {cv.currentModel === '' ? '…' : cv.currentModel}
        {models.length > 1 && <ChevronDown size={11} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />}
      </button>
      {open && (
        <>
          {/* 点外面收起（透明遮罩层） */}
          <button aria-label="关闭" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <span className="absolute right-0 z-20 mt-1 block max-h-64 overflow-y-auto rounded border border-line-strong bg-surface py-1 shadow-xl">
            {models.map((m) => (
              <button
                key={m}
                onClick={() => pick(m)}
                className={`block w-full px-3 py-1.5 text-left text-xs whitespace-nowrap hover:bg-surface-raised ${m === cv.currentModel ? 'text-emerald-400' : 'text-body'}`}
              >
                {m}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

export function App(): React.JSX.Element {
  const [ready, setReady] = useState(getToken() !== '')
  const [checked, setChecked] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  // 添加项目（侧栏「+」——内联表单；错误就地展示，成功即选中进 hero 态）
  const [adding, setAdding] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [addErr, setAddErr] = useState('')
  const [creating, setCreating] = useState(false)
  // 批 2 会话列表升级：搜索 / 归档面板 / 行内重命名
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<SidebarSession[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // C4-④：用量面板（侧栏底部入口——全局视角与项目选择无关）
  const [statsOpen, setStatsOpen] = useState(false)
  const { projects, sessions, selectedProject, selectedSession, select, setProjects, applyHost, applyFrame, setConn, upsertSession, setConfigView } = useApp()
  const loadHistory = useApp((s) => s.loadHistory)
  // hashchange 闭包读最新选中态（effect 只挂一次 select 依赖）
  const selectedProjectRef = useRef(selectedProject)
  selectedProjectRef.current = selectedProject
  const selectedSessionRef = useRef(selectedSession)
  selectedSessionRef.current = selectedSession

  // token 预检（已有 token 验证可达性）。401 时 connect 层已 clearToken → 回 token 门重输
  // （G3 挂账缺陷：此前 401 也进主界面 → mux 无限退避"重连中"，被锁死只能手动清存储）
  useEffect(() => {
    if (getToken() === '') {
      setChecked(true)
      return
    }
    fetchProjects(BASE)
      .then(() => setReady(true))
      .catch(() => {
        if (getToken() === '') {
          setReady(false)
          setUnauthorized(true)
        } else setReady(true) // 网络类失败仍进主界面（mux 状态条显示重连）
      })
      .finally(() => setChecked(true))
  }, [])

  // mux 连接（ready 后建立）。服务端为全量广播语义（?sessionId 被忽略——审阅 P1-5 注释改真）；
  // 随选中会话重订保留作兜底：重建连接触发 baseline+refreshSessions 补拉，恰好覆盖
  // "切会话间隙丢帧"与断线重放两个场景
  useEffect(() => {
    if (!ready) return
    let conn: MuxConnection | undefined
    // 连接建立（含切会话重订/断线重连）即补拉：①会话列表——重订间隙丢 thread/status 帧
    // （新会话转正瞬间 busy 帧丢失卡"运行中"，G3 实测）；②当前会话全量 session/read——
    // 断线/重订期间丢的 delta/turn 帧导致内容缺尾（W6b onReconnect 语义）。
    // W-9（批 4）：重连基线——游标在连接建立时快照（有基线=本次 open 走 mux 重放补帧，
    // 跳过全量 session/read；gap/seq 回绕由 session/subscribed→resync 全量重同步兜底）
    const cursorAtConnect = selectedSessionRef.current !== null ? lastSeqFor(selectedSessionRef.current) : null
    const replayed = cursorAtConnect !== null
    const refreshSessions = (): void => {
      fetchProjects(BASE).then((p) => setProjects([...new Set([...(p.registered ?? []).map((x) => x.path), ...(p.history ?? [])])])).catch(() => {})
      if (selectedProject !== null) {
        sendCommand(BASE, selectedProject, undefined, { op: 'session/list' })
          .then((r) => {
            if (r.ok && Array.isArray(r.value)) {
              for (const m of r.value as Array<{ sessionId: string; firstUser: string; title?: string; createdAt: string; running?: boolean; archived?: boolean }>) {
                upsertSession({ project: selectedProject, sessionId: m.sessionId, running: m.running ?? false, title: m.title ?? m.firstUser ?? '', updatedAt: m.createdAt ? Date.parse(m.createdAt) : Date.now() })
              }
            }
          })
          .catch(() => {})
      }
      if (selectedSession !== null && selectedSession !== '' && !replayed) {
        sendCommand(BASE, selectedProject ?? '', selectedSession, { op: 'session/read', sessionId: selectedSession })
          .then((r) => {
            if (r.ok) loadHistory(selectedSession, r.value)
          })
          .catch(() => {})
      }
    }
    conn = connectMux(
      BASE,
      {
        onFrame: applyFrame,
        onHost: applyHost,
        onState: (s) => {
          setConn(s)
          if (s === 'open') refreshSessions()
        },
        // token 失效：connect 层已 clearToken + 停止重试——回 token 门带提示重输
        onUnauthorized: () => {
          setReady(false)
          setUnauthorized(true)
        },
      },
      selectedSession ?? undefined,
      // W-9：实时读游标——每次连接尝试（含内部重连）都携带最新基线
      () => (selectedSessionRef.current !== null ? lastSeqFor(selectedSessionRef.current) : null),
    )
    fetchProjects(BASE)
      .then((p) => setProjects([...new Set([...(p.registered ?? []).map((x) => x.path), ...(p.history ?? [])])]))
      .catch(() => {})
    return () => conn?.dispose()
    // upsertSession 稳定（zustand action）；refreshSessions 闭包按 selectedProject 重建
  }, [ready, selectedSession, selectedProject, applyFrame, applyHost, setConn, setProjects, upsertSession, loadHistory])

  // 选项目 → 拉该会话列表（session/list——冷热合并）+ 该项目模型视图（config/get——
  // 每项目独立 current，顶栏芯片须跟随选中项目；切走再切回也重拉防陈旧）
  useEffect(() => {
    if (selectedProject === null) return
    sendCommand(BASE, selectedProject, undefined, { op: 'config/get' })
      .then((r) => {
        const v = r.ok ? toConfigView(r.value) : null
        if (v !== null) setConfigView(v)
      })
      .catch(() => {})
    sendCommand(BASE, selectedProject, undefined, { op: 'session/list' })
      .then((r) => {
        if (r.ok && Array.isArray(r.value)) {
          for (const m of r.value as Array<{ sessionId: string; firstUser: string; title?: string; createdAt: string; running?: boolean; archived?: boolean }>) {
            upsertSession({ project: selectedProject, sessionId: m.sessionId, running: m.running ?? false, title: m.title ?? m.firstUser ?? '', updatedAt: m.createdAt ? Date.parse(m.createdAt) : Date.now() })
          }
        }
      })
      .catch(() => {})
  }, [selectedProject, upsertSession])

  // —— hash 路由双向同步。顺序敏感：hash→store 必须先声明——首帧 store→hash 会把未初始化
  // 的 null 选择态写回 hash，冷启动/刷新深链（#/p/.../s/...）在挂载 effect 链里被覆盖丢失 ——
  useEffect(() => {
    const apply = (): void => {
      const h = parseHash(location.hash)
      const cur: RoutePos = { p: selectedProjectRef.current, s: selectedSessionRef.current }
      if (h.p !== cur.p || h.s !== cur.s) select(h.p, h.s)
    }
    apply() // 首挂载吃深链
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [select])
  useEffect(() => {
    const fromStore: RoutePos = { p: selectedProject, s: selectedSession }
    if (makeHash(fromStore) !== location.hash) location.hash = makeHash(fromStore)
  }, [selectedProject, selectedSession])

  // 批 2：主列表=未归档；搜索走客户端子串；时间分组（今日/昨日/过去 7 天/更早）
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.project === selectedProject && s.archived !== true).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, selectedProject],
  )
  const searchedSessions = useMemo(() => searchSessions(activeSessions, query), [activeSessions, query])
  const sessionGroups = useMemo(() => groupSessionsByTime(searchedSessions), [searchedSessions])

  /** 归档面板数据：session/list includeArchived 拉全量后拆归档桶 */
  const loadArchived = (): void => {
    if (selectedProject === null) return
    sendCommand(BASE, selectedProject, undefined, { op: 'session/list', includeArchived: true })
      .then((r) => {
        if (r.ok && Array.isArray(r.value)) {
          const arch: SidebarSession[] = (r.value as Array<{ sessionId: string; firstUser?: string; title?: string; createdAt: string; archived?: boolean }>)
            .filter((m) => m.archived === true)
            .map((m) => ({
              sessionId: m.sessionId,
              title: m.title ?? m.firstUser ?? '',
              updatedAt: m.createdAt ? Date.parse(m.createdAt) : 0,
              running: false,
              archived: true,
            }))
          setArchivedSessions(arch)
        }
      })
      .catch(() => {})
  }

  const toggleShowArchived = (): void => {
    const next = !showArchived
    setShowArchived(next)
    if (next) loadArchived()
  }

  /** 归档/恢复：协议落 sidecar + session/updated 帧广播多端；本端乐观刷新两个列表 */
  const setSessionArchived = (sessionId: string, archived: boolean): void => {
    if (selectedProject === null) return
    void sendCommand(BASE, selectedProject, undefined, { op: 'session/archive', sessionId, archived })
      .then(() => {
        if (archived) {
          setArchivedSessions((prev) => {
            const src = prev.length > 0 ? prev : activeSessions.map((s) => ({ ...s, archived: true as const }))
            return src.map((s) => (s.sessionId === sessionId ? { ...s, archived: true as const } : s))
          })
        } else {
          setArchivedSessions((prev) => prev.filter((s) => s.sessionId !== sessionId))
          sendCommand(BASE, selectedProject, undefined, { op: 'session/list' })
            .then((r) => {
              if (r.ok && Array.isArray(r.value)) {
                for (const m of r.value as Array<{ sessionId: string; firstUser?: string; title?: string; createdAt: string; running?: boolean }>) {
                  upsertSession({
                    project: selectedProject,
                    sessionId: m.sessionId,
                    running: m.running ?? false,
                    title: m.title ?? m.firstUser ?? '',
                    updatedAt: m.createdAt ? Date.parse(m.createdAt) : Date.now(),
                  })
                }
              }
            })
            .catch(() => {})
        }
      })
      .catch(() => {})
  }

  const renameSession = (sessionId: string, title: string): void => {
    const t = title.trim()
    if (t === '') return
    void sendCommand(BASE, selectedProject ?? '', undefined, { op: 'session/rename', sessionId, title: t })
      .then(() => {
        const s = useApp.getState().sessions.find((x) => x.sessionId === sessionId)
        if (s !== undefined) upsertSession({ ...s, title: t })
      })
      .catch(() => {})
  }

  /** 真新建会话（「+新对话」/hero 输入共用）：serve 信封层 session/new → 实 id 转正选中。
   *  旧「''占位+prompt 隐式建」废弃（缺省路由复用默认会话——两次 +新对话进同一会话的病灶） */
  const startNewSession = (): void => {
    if (selectedProject === null || creating) return
    setCreating(true)
    sendCommand(BASE, selectedProject, undefined, { op: 'session/new' })
      .then((r) => {
        if (r.ok && r.sessionId !== undefined && r.sessionId !== '') {
          loadHistory(r.sessionId, [])
          upsertSession({ project: selectedProject, sessionId: r.sessionId, running: false, title: '', updatedAt: Date.now() })
          select(selectedProject, r.sessionId)
        }
      })
      .catch(() => {})
      .finally(() => setCreating(false))
  }

  /** 添加项目：注册即入列表（不冷起宿主）；成功用服务端规范化路径选中（导航 /api/p 须同串） */
  const submitAddProject = (): void => {
    const p = newPath.trim()
    if (p === '' || addBusy) return
    setAddBusy(true)
    setAddErr('')
    addProject(BASE, p)
      .then(async (norm) => {
        const list = await fetchProjects(BASE)
        setProjects([...new Set([...(list.registered ?? []).map((x) => x.path), ...(list.history ?? [])])])
        setAdding(false)
        setNewPath('')
        select(norm, null)
      })
      .catch((e: unknown) => setAddErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setAddBusy(false))
  }

  if (!checked) return <div className="flex h-full items-center justify-center text-sm text-faint">…</div>
  if (!ready)
    return (
      <TokenGate
        hint={unauthorized ? 'token 已失效（daemon 重启会更换 token）——请重新输入' : undefined}
        onReady={() => {
          setUnauthorized(false)
          setReady(true)
        }}
      />
    )

  // W7 移动两态：选中会话后主区占满（侧栏隐藏，顶栏返回）；md 以上常驻双栏
  const mobileDetail = selectedSession !== null

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* 侧栏（桌面常驻；移动=列表态显示） */}
      <aside className={`flex w-full shrink-0 flex-col border-b border-line md:flex md:w-72 md:border-b-0 md:border-r ${mobileDetail ? 'hidden' : 'flex'}`}>
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-sm font-semibold tracking-wide">ECode</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStatsOpen(true)}
              title="用量统计（近 7 天）"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-body"
            >
              <BarChart3 size={13} />
            </button>
            <ConnBadge />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="flex items-center justify-between px-1 pb-1 pt-2 text-[11px] uppercase tracking-wider text-faint">
            项目
            <button
              onClick={() => {
                setAdding(!adding)
                setAddErr('')
              }}
              title="添加项目（本机绝对路径）"
              className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-body"
            >
              <Plus size={12} />
            </button>
          </div>
          {adding && (
            <form
              className="mb-1 px-1"
              onSubmit={(e) => {
                e.preventDefault()
                submitAddProject()
              }}
            >
              <input
                autoFocus
                value={newPath}
                onChange={(e) => {
                  setNewPath(e.target.value)
                  if (addErr !== '') setAddErr('')
                }}
                placeholder="本机项目绝对路径（D:/study/foo）"
                className="w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-xs outline-none focus:border-line-strong"
              />
              {addErr !== '' && <div className="pt-1 text-[11px] text-red-400">{addErr}</div>}
              <div className="flex gap-1.5 pt-1.5">
                <button type="submit" disabled={newPath.trim() === '' || addBusy} className="rounded bg-neutral-200 px-2 py-1 text-[11px] font-medium text-canvas disabled:opacity-30">
                  {addBusy ? '添加中…' : '添加'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    setNewPath('')
                    setAddErr('')
                  }}
                  className="rounded px-2 py-1 text-[11px] text-muted hover:text-body"
                >
                  取消
                </button>
              </div>
            </form>
          )}
          {projects.map((p) => {
            const short = p.split('/').filter(Boolean).slice(-2).join('/')
            const selected = selectedProject === p
            return (
              <div key={p} className={`flex w-full items-center rounded ${selected ? 'bg-surface-raised' : 'hover:bg-surface-raised/60'}`}>
                <button onClick={() => select(p, null)} className="min-w-0 flex-1 px-2 py-1.5 text-left text-sm">
                  <span className="truncate text-body" title={p}>
                    {short}
                  </span>
                </button>
                {selected && (
                  <button
                    onClick={toggleShowArchived}
                    title="已归档会话"
                    className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded ${showArchived ? 'text-amber-400' : 'text-muted'} hover:bg-neutral-700 hover:text-body`}
                  >
                    <Archive size={12} />
                  </button>
                )}
              </div>
            )
          })}
          {projects.length === 0 && <div className="px-2 py-3 text-xs text-faint">暂无项目——点上方「+」添加，或在本机项目里跑一次 ecode</div>}
          {selectedProject !== null && (
            <>
              <div className="flex items-center gap-1.5 px-1 pb-1 pt-3">
                <Search size={11} className="shrink-0 text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索会话…"
                  className="w-full min-w-0 rounded border border-line bg-surface px-2 py-1 text-xs outline-none placeholder:text-faint focus:border-line-strong"
                />
              </div>
              {query.trim() !== '' ? (
                searchedSessions.length > 0 ? (
                  searchedSessions.map((s) => (
                    <SessionRow
                      key={s.sessionId}
                      brief={s}
                      active={selectedSession === s.sessionId}
                      onClick={() => select(selectedProject, s.sessionId)}
                      onArchive={() => setSessionArchived(s.sessionId, true)}
                      onRenameStart={() => {
                        setRenamingId(s.sessionId)
                        setRenameValue(s.title === '' ? s.sessionId.slice(-12) : s.title)
                      }}
                      renameMode={renamingId === s.sessionId}
                      renameValue={renameValue}
                      onRenameChange={setRenameValue}
                      onRenameSubmit={() => {
                        renameSession(s.sessionId, renameValue)
                        setRenamingId(null)
                      }}
                      onRenameCancel={() => setRenamingId(null)}
                    />
                  ))
                ) : (
                  <div className="px-2 py-2 text-xs text-faint">无匹配会话</div>
                )
              ) : (
                sessionGroups.map((g) => (
                  <div key={g.label}>
                    <div className="px-1 pb-0.5 pt-2 text-[11px] text-faint">{g.label}</div>
                    {g.items.map((s) => (
                      <SessionRow
                        key={s.sessionId}
                        brief={s}
                        active={selectedSession === s.sessionId}
                        onClick={() => select(selectedProject, s.sessionId)}
                        onArchive={() => setSessionArchived(s.sessionId, true)}
                        onRenameStart={() => {
                          setRenamingId(s.sessionId)
                          setRenameValue(s.title === '' ? s.sessionId.slice(-12) : s.title)
                        }}
                        renameMode={renamingId === s.sessionId}
                        renameValue={renameValue}
                        onRenameChange={setRenameValue}
                        onRenameSubmit={() => {
                          renameSession(s.sessionId, renameValue)
                          setRenamingId(null)
                        }}
                        onRenameCancel={() => setRenamingId(null)}
                      />
                    ))}
                  </div>
                ))
              )}
              <button
                onClick={startNewSession}
                disabled={creating}
                className="mt-1 w-full rounded border border-dashed border-line-strong px-2 py-1.5 text-xs text-muted hover:border-line-strong hover:text-body disabled:opacity-40"
              >
                {creating ? '新建中…' : '+ 新对话'}
              </button>
              {showArchived && (
                <div className="mt-1 rounded border border-line/80 px-1.5 py-1.5">
                  <div className="px-0.5 pb-1 text-[11px] text-amber-500/90">已归档会话</div>
                  {archivedSessions.length === 0 && <div className="px-1 py-1 text-[11px] text-faint">无归档会话</div>}
                  {archivedSessions.map((s) => (
                    <div key={s.sessionId} className="flex w-full items-center rounded hover:bg-surface-raised/60">
                      <button onClick={() => select(selectedProject, s.sessionId)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-muted" title="点击打开归档会话">
                        {s.title === '' ? s.sessionId.slice(-12) : s.title}
                      </button>
                      <button onClick={() => setSessionArchived(s.sessionId, false)} title="恢复到主列表" className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-neutral-700 hover:text-body">
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
      {/* 主列（移动=详情态占满+顶栏返回；桌面常驻）：滚动体（hero/对话）+ 常驻底部输入区 */}
      <main className={`flex min-h-0 flex-1 flex-col ${mobileDetail ? 'flex' : 'hidden md:flex'}`}>
        {mobileDetail && (
          <div className="flex items-center gap-2 border-b border-line px-2 py-2 md:hidden">
            <button onClick={() => select(selectedProject, null)} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-dim hover:text-bright">
              <ArrowLeft size={16} /> 返回
            </button>
            <span className="truncate text-sm text-muted">{selectedProject?.split('/').filter(Boolean).slice(-2).join('/')}</span>
            <span className="ml-auto">
              <ModelChip />
            </span>
          </div>
        )}
        {/* 桌面顶栏：项目路径 + 模型芯片（model/set 入口） */}
        {selectedProject !== null && (
          <div className="hidden items-center justify-between border-b border-line px-4 py-1.5 md:flex">
            <span className="truncate text-xs text-muted" title={selectedProject}>
              {selectedProject}
            </span>
            <ModelChip />
          </div>
        )}
        {selectedProject === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="text-base font-semibold tracking-wide">ECode</div>
            <div className="max-w-md text-sm text-faint">选择左侧项目开始，或点侧栏「+」添加本机项目</div>
          </div>
        ) : selectedSession === null ? (
          // hero 态：输入即开新对话（composer 常驻下方——harness 空 hero + 常驻 bar 同款）
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <div className="text-lg font-semibold tracking-wide">新对话</div>
            <div className="max-w-md text-sm text-muted">在下方输入框输入即开新对话；或从左侧选择历史会话继续。</div>
            <div className="max-w-md truncate rounded border border-line px-2 py-1 font-mono text-[11px] text-faint" title={selectedProject}>
              {selectedProject}
            </div>
          </div>
        ) : (
          <Conversation project={selectedProject} sessionId={selectedSession} />
        )}
        {/* 常驻输入区（session-optional）：未选项目禁用占位；审批/单选挂起时 takeover 占位 */}
        <KeyboardAware>
          <Composer project={selectedProject} sessionId={selectedSession} />
        </KeyboardAware>
      </main>
      {statsOpen && <StatsPanel onClose={() => setStatsOpen(false)} />}
    </div>
  )
}
