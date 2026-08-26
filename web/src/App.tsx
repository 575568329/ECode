/**
 * M13-W5 骨架页：token 门 → 两级列表（项目 → 会话）+ 连接状态条。
 * W6a/b 在此长出对话区与审批 UI。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { connectMux, fetchProjects, getToken, setToken, sendCommand, type MuxConnection } from './connect'
import { useApp, type SessionBrief } from './store'
import { Conversation } from './Conversation'

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

/** hash 路由（零服务端改动——SPA 免 fallback）：#/p/<项目>[/s/<会话|new>]。
 * 深链/刷新/后退可用；store↔hash 双向同步（先比对防回环）。 */
interface RoutePos {
  p: string | null
  s: string | null // null=未选会话；''=新对话占位
}
function parseHash(): RoutePos {
  const m = /^#\/p\/([^/]+)(?:\/s\/([^/]+))?$/.exec(location.hash)
  if (m === null) return { p: null, s: null }
  return { p: decodeURIComponent(m[1]), s: m[2] === undefined ? null : m[2] === 'new' ? '' : decodeURIComponent(m[2]) }
}
function makeHash(pos: RoutePos): string {
  if (pos.p === null) return '#/'
  const base = `#/p/${encodeURIComponent(pos.p)}`
  return pos.s === null ? base : `${base}/s/${pos.s === '' ? 'new' : encodeURIComponent(pos.s)}`
}

export function App(): React.JSX.Element {
  const [ready, setReady] = useState(getToken() !== '')
  const [checked, setChecked] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  const { projects, sessions, selectedProject, selectedSession, select, setProjects, applyHost, applyFrame, setConn, upsertSession } = useApp()
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
    // 连接建立（含切会话重订/断线重连）即补拉会话列表——重订间隙会丢 thread/status 帧
    // （新会话转正瞬间 busy 帧丢失卡"运行中"，G3 实测）；session/list 幂等便宜
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
  }, [ready, selectedSession, selectedProject, applyFrame, applyHost, setConn, setProjects, upsertSession])

  // 选项目 → 拉该会话列表（session/list——冷热合并）
  useEffect(() => {
    if (selectedProject === null) return
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

  // —— hash 路由双向同步（store→hash 写历史记录；hash→store 供后退/深链/刷新；先比对防回环） ——
  useEffect(() => {
    const fromStore: RoutePos = { p: selectedProject, s: selectedSession }
    if (makeHash(fromStore) !== location.hash) location.hash = makeHash(fromStore)
  }, [selectedProject, selectedSession])
  useEffect(() => {
    const apply = (): void => {
      const h = parseHash()
      const cur: RoutePos = { p: selectedProjectRef.current, s: selectedSessionRef.current }
      if (h.p !== cur.p || h.s !== cur.s) select(h.p, h.s)
    }
    apply() // 首挂载吃深链
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [select])

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.project === selectedProject).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, selectedProject],
  )

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
          <div className="px-1 pb-1 pt-2 text-[11px] uppercase tracking-wider text-neutral-600">项目</div>
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
          {projects.length === 0 && <div className="px-2 py-3 text-xs text-neutral-600">暂无项目（daemon 侧跑一次会话后出现）</div>}
          {selectedProject !== null && (
            <>
              <div className="px-1 pb-1 pt-3 text-[11px] uppercase tracking-wider text-neutral-600">会话</div>
              {projectSessions.map((s) => (
                <SessionRow key={s.sessionId} brief={s} active={selectedSession === s.sessionId} onClick={() => select(selectedProject, s.sessionId)} />
              ))}
              <button
                onClick={() => {
                  // 新建对话：prompt 不带 sessionId=隐式建（三态③）——骨架期发个占位会先建立；
                  // W6b 接输入框后由真实 prompt 触发
                  select(selectedProject, '')
                }}
                className="mt-1 w-full rounded border border-dashed border-neutral-700 px-2 py-1.5 text-xs text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
              >
                + 新对话
              </button>
            </>
          )}
        </div>
      </aside>
      {/* 对话区（移动=详情态占满+顶栏返回；桌面常驻） */}
      <main className={`flex min-h-0 flex-1 flex-col ${mobileDetail ? 'flex' : 'hidden md:flex'}`}>
        {mobileDetail && (
          <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-2 md:hidden">
            <button onClick={() => select(selectedProject, null)} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-neutral-400 hover:text-neutral-200">
              <ArrowLeft size={16} /> 返回
            </button>
            <span className="truncate text-sm text-neutral-500">{selectedProject?.split('/').filter(Boolean).slice(-2).join('/')}</span>
          </div>
        )}
        {selectedProject === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">选择左侧项目</div>
        ) : selectedSession === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">选择会话或新建对话</div>
        ) : (
          // selectedSession 可能是空串（+ 新对话 占位）——Conversation 空态 + Composer isNew 发送后转正
          <Conversation project={selectedProject} sessionId={selectedSession} />
        )}
      </main>
    </div>
  )
}
