/**
 * M13-W5 骨架页：token 门 → 两级列表（项目 → 会话）+ 连接状态条。
 * W8 布局批（harness 同款 AppFrame 形）：主列 = 滚动体（hero/对话）+ 常驻底部输入区
 * （session-optional——未选项目禁用占位、hero 态输入即开新对话）；侧栏可添加项目。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Plus } from 'lucide-react'
import { addProject, connectMux, fetchProjects, getToken, setToken, sendCommand, type MuxConnection } from './connect'
import { toConfigView, useApp, type SessionBrief } from './store'
import { makeHash, parseHash, type RoutePos } from './routing'
import { Conversation } from './Conversation'
import { Composer } from './Composer'

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
        <div className="text-sm text-neutral-400">连接 ECode daemon（~/.ecode/server.json 的 token）</div>
        {hint !== undefined && hint !== '' && <div className="text-xs text-amber-400">⚠ {hint}</div>}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="token"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        {error !== '' && <div className="text-xs text-red-400">{error}</div>}
        <button type="submit" className="w-full rounded bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-900">
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
    <span className="flex items-center gap-1.5 text-xs text-neutral-500">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {connState === 'open' ? '已连接' : connState === 'connecting' ? '连接中' : '重连中'}
    </span>
  )
}

function SessionRow({ brief, active, onClick }: { brief: SessionBrief; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${active ? 'bg-neutral-800' : 'hover:bg-neutral-800/60'}`}
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${brief.running ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'}`} />
      <span className="truncate text-neutral-300">{brief.title === '' ? brief.sessionId.slice(-12) : brief.title}</span>
    </button>
  )
}

/** W7：软键盘视口跟随（iOS visualViewport——键盘弹起时压缩可视高度，输入区保持可见） */
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
  return <div style={{ height: 'var(--vvh, auto)' }}>{children}</div>
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
        className="flex items-center gap-1 rounded border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
        title={`provider: ${cv.currentName}`}
      >
        {cv.currentModel === '' ? '…' : cv.currentModel}
        {models.length > 1 && <ChevronDown size={11} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />}
      </button>
      {open && (
        <>
          {/* 点外面收起（透明遮罩层） */}
          <button aria-label="关闭" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <span className="absolute right-0 z-20 mt-1 block max-h-64 overflow-y-auto rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
            {models.map((m) => (
              <button
                key={m}
                onClick={() => pick(m)}
                className={`block w-full px-3 py-1.5 text-left text-xs whitespace-nowrap hover:bg-neutral-800 ${m === cv.currentModel ? 'text-emerald-400' : 'text-neutral-300'}`}
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

  // mux 连接（ready 后建立；随选中会话重订——serve 按订阅会话推帧，切会话不重订则收不到
  // 该会话的 delta/turn/审批帧，G3 实测缺口；未选会话时订阅项目默认流保 host 列表帧）
  useEffect(() => {
    if (!ready) return
    let conn: MuxConnection | undefined
    // 连接建立（含切会话重订/断线重连）即补拉：①会话列表——重订间隙丢 thread/status 帧
    // （新会话转正瞬间 busy 帧丢失卡"运行中"，G3 实测）；②当前会话全量 session/read——
    // 断线/重订期间丢的 delta/turn 帧导致内容缺尾（W6b onReconnect 语义：不做增量补帧，
    // 服务端权威全量重拉，loadHistory 同步清 streaming/items/queue）
    const refreshSessions = (): void => {
      fetchProjects(BASE).then((p) => setProjects([...new Set([...(p.registered ?? []).map((x) => x.path), ...(p.history ?? [])])])).catch(() => {})
      if (selectedProject !== null) {
        sendCommand(BASE, selectedProject, undefined, { op: 'session/list' })
          .then((r) => {
            if (r.ok && Array.isArray(r.value)) {
              for (const m of r.value as Array<{ sessionId: string; firstUser: string; createdAt: string; running?: boolean }>) {
                upsertSession({ project: selectedProject, sessionId: m.sessionId, running: m.running ?? false, title: m.firstUser ?? '', updatedAt: m.createdAt ? Date.parse(m.createdAt) : Date.now() })
              }
            }
          })
          .catch(() => {})
      }
      if (selectedSession !== null && selectedSession !== '') {
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
          for (const m of r.value as Array<{ sessionId: string; firstUser: string; createdAt: string; running?: boolean }>) {
            upsertSession({ project: selectedProject, sessionId: m.sessionId, running: m.running ?? false, title: m.firstUser ?? '', updatedAt: m.createdAt ? Date.parse(m.createdAt) : Date.now() })
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

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.project === selectedProject).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, selectedProject],
  )

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

  if (!checked) return <div className="flex h-full items-center justify-center text-sm text-neutral-600">…</div>
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
      <aside className={`flex w-full shrink-0 flex-col border-b border-neutral-800 md:flex md:w-72 md:border-b-0 md:border-r ${mobileDetail ? 'hidden' : 'flex'}`}>
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-sm font-semibold tracking-wide">ECode</span>
          <ConnBadge />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="flex items-center justify-between px-1 pb-1 pt-2 text-[11px] uppercase tracking-wider text-neutral-600">
            项目
            <button
              onClick={() => {
                setAdding(!adding)
                setAddErr('')
              }}
              title="添加项目（本机绝对路径）"
              className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
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
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
              />
              {addErr !== '' && <div className="pt-1 text-[11px] text-red-400">{addErr}</div>}
              <div className="flex gap-1.5 pt-1.5">
                <button type="submit" disabled={newPath.trim() === '' || addBusy} className="rounded bg-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-900 disabled:opacity-30">
                  {addBusy ? '添加中…' : '添加'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    setNewPath('')
                    setAddErr('')
                  }}
                  className="rounded px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-300"
                >
                  取消
                </button>
              </div>
            </form>
          )}
          {projects.map((p) => {
            const short = p.split('/').filter(Boolean).slice(-2).join('/')
            return (
              <button
                key={p}
                onClick={() => select(p, null)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${selectedProject === p ? 'bg-neutral-800' : 'hover:bg-neutral-800/60'}`}
              >
                <span className="truncate text-neutral-300" title={p}>
                  {short}
                </span>
              </button>
            )
          })}
          {projects.length === 0 && <div className="px-2 py-3 text-xs text-neutral-600">暂无项目——点上方「+」添加，或在本机项目里跑一次 ecode</div>}
          {selectedProject !== null && (
            <>
              <div className="px-1 pb-1 pt-3 text-[11px] uppercase tracking-wider text-neutral-600">会话</div>
              {projectSessions.map((s) => (
                <SessionRow key={s.sessionId} brief={s} active={selectedSession === s.sessionId} onClick={() => select(selectedProject, s.sessionId)} />
              ))}
              <button
                onClick={startNewSession}
                disabled={creating}
                className="mt-1 w-full rounded border border-dashed border-neutral-700 px-2 py-1.5 text-xs text-neutral-500 hover:border-neutral-500 hover:text-neutral-300 disabled:opacity-40"
              >
                {creating ? '新建中…' : '+ 新对话'}
              </button>
            </>
          )}
        </div>
      </aside>
      {/* 主列（移动=详情态占满+顶栏返回；桌面常驻）：滚动体（hero/对话）+ 常驻底部输入区 */}
      <main className={`flex min-h-0 flex-1 flex-col ${mobileDetail ? 'flex' : 'hidden md:flex'}`}>
        {mobileDetail && (
          <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-2 md:hidden">
            <button onClick={() => select(selectedProject, null)} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-neutral-400 hover:text-neutral-200">
              <ArrowLeft size={16} /> 返回
            </button>
            <span className="truncate text-sm text-neutral-500">{selectedProject?.split('/').filter(Boolean).slice(-2).join('/')}</span>
            <span className="ml-auto">
              <ModelChip />
            </span>
          </div>
        )}
        {/* 桌面顶栏：项目路径 + 模型芯片（model/set 入口） */}
        {selectedProject !== null && (
          <div className="hidden items-center justify-between border-b border-neutral-800 px-4 py-1.5 md:flex">
            <span className="truncate text-xs text-neutral-500" title={selectedProject}>
              {selectedProject}
            </span>
            <ModelChip />
          </div>
        )}
        {selectedProject === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="text-base font-semibold tracking-wide">ECode</div>
            <div className="max-w-md text-sm text-neutral-600">选择左侧项目开始，或点侧栏「+」添加本机项目</div>
          </div>
        ) : selectedSession === null ? (
          // hero 态：输入即开新对话（composer 常驻下方——harness 空 hero + 常驻 bar 同款）
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <div className="text-lg font-semibold tracking-wide">新对话</div>
            <div className="max-w-md text-sm text-neutral-500">在下方输入框输入即开新对话；或从左侧选择历史会话继续。</div>
            <div className="max-w-md truncate rounded border border-neutral-800 px-2 py-1 font-mono text-[11px] text-neutral-600" title={selectedProject}>
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
    </div>
  )
}
