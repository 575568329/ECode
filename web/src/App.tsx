/**
 * M13-W5 骨架页：token 门 → 两级列表（项目 → 会话）+ 连接状态条。
 * W6a/b 在此长出对话区与审批 UI。
 */

import { useEffect, useMemo, useState } from 'react'
import { connectMux, fetchProjects, getToken, setToken, sendCommand, type MuxConnection } from './connect'
import { useApp, type SessionBrief } from './store'

/** 同源定位 daemon（dev 模式经 vite proxy；托管形态同源直连） */
const BASE = ''

function TokenGate({ onReady }: { onReady: () => void }): React.JSX.Element {
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
          fetchProjects(BASE)
            .then(() => onReady())
            .catch((err: unknown) => setError(String(err)))
        }}
      >
        <div className="text-sm text-neutral-400">连接 ECode daemon（~/.ecode/server.json 的 token）</div>
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

export function App(): React.JSX.Element {
  const [ready, setReady] = useState(getToken() !== '')
  const [checked, setChecked] = useState(false)
  const { projects, sessions, selectedProject, selectedSession, select, setProjects, applyHost, applyFrame, setConn, upsertSession } = useApp()

  // token 预检（已有 token 验证可达性）
  useEffect(() => {
    if (getToken() === '') {
      setChecked(true)
      return
    }
    fetchProjects(BASE)
      .then(() => setReady(true))
      .catch(() => setReady(true)) // 失败也进主界面（mux 状态条会显示重连）——token 错在命令层报
      .finally(() => setChecked(true))
  }, [])

  // mux 连接（ready 后建立一次）
  useEffect(() => {
    if (!ready) return
    let conn: MuxConnection | undefined
    conn = connectMux(BASE, {
      onFrame: applyFrame,
      onHost: applyHost,
      onState: setConn,
      onReconnect: () => {
        fetchProjects(BASE).then((p) => setProjects([...new Set([...(p.registered ?? []).map((x) => x.path), ...(p.history ?? [])])])).catch(() => {})
      },
    })
    fetchProjects(BASE)
      .then((p) => setProjects([...new Set([...(p.registered ?? []).map((x) => x.path), ...(p.history ?? [])])]))
      .catch(() => {})
    return () => conn?.dispose()
  }, [ready, applyFrame, applyHost, setConn, setProjects])

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

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.project === selectedProject).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, selectedProject],
  )

  if (!checked) return <div className="flex h-full items-center justify-center text-sm text-neutral-600">…</div>
  if (!ready) return <TokenGate onReady={() => setReady(true)} />

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* 侧栏（桌面）/主列表（移动两态由选中态切换——W7 细化） */}
      <aside className="flex w-full shrink-0 flex-col border-b border-neutral-800 md:w-72 md:border-b-0 md:border-r">
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
      {/* 对话区（W6a/b 长出） */}
      <main className="flex flex-1 items-center justify-center">
        <div className="text-center text-sm text-neutral-600">
          {selectedSession === null ? '选择左侧会话' : selectedSession === '' ? '输入你的问题开始对话（W6b 接入）' : `会话 ${selectedSession.slice(-12)}（W6a 渲染接入）`}
        </div>
      </main>
    </div>
  )
}
