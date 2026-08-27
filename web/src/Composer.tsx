/**
 * M13-W6b 交互层 + W8 常驻化（harness 同款：composer 是 session-optional 常驻位——
 * 「inert 是 prop 不是另一棵树」，全状态渲染在主列底部，textarea DOM 跨状态存活不重建焦点）：
 * - 未选项目：禁用占位（「先选择左侧项目…」）；
 * - 选了项目未选会话（hero 态）：输入即开新对话——session/new 真新建（不落 ensureDefault
 *   复用默认会话的旧病灶）→ 回执实 id 转正选中 → 首条 prompt 显式路由；
 * - 已选会话：prompt 三态（StartOrSteer 插话）。
 * 审批/单选 takeover（挂起时占据输入位）只在已选会话时存在——view 无即常态输入。
 * IME：isComposing 期间 Enter 不提交（中文输入法必踩）。
 */

import { useEffect, useRef, useState } from 'react'
import { Ban, Check, ShieldAlert, Trash2 } from 'lucide-react'
import { sendCommand } from './connect'
import { useApp } from './store'

export function Composer({ project, sessionId }: { project: string | null; sessionId: string | null }): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const composingRef = useRef(false)
  // hero 态（sessionId=null）无 view——takeover 分支自然不可达
  const view = useApp((s) => (sessionId !== null ? s.views[sessionId] : undefined))
  const running = useApp((s) => (sessionId !== null ? (s.sessions.find((x) => x.sessionId === sessionId)?.running ?? false) : false))
  const select = useApp((s) => s.select)
  const upsertSession = useApp((s) => s.upsertSession)
  const loadHistory = useApp((s) => s.loadHistory)
  const appendUser = useApp((s) => s.appendUser)

    const submit = async (): Promise<void> => {
    const t = text.trim()
    if (t === '' || sending || project === null) return
    setSending(true)
    setErr('')
    try {
      // hero 态：先真新建（serve 信封层拦截 session/new——ensure 挂活+created 帧广播）再发首条
      let sid = sessionId ?? ''
      if (sid === '') {
        const rn = await sendCommand('', project, undefined, { op: 'session/new' })
        if (!rn.ok || rn.sessionId === undefined || rn.sessionId === '') {
          setErr(String(rn.error ?? '新建会话失败'))
          return
        }
        sid = rn.sessionId
        loadHistory(sid, [])
        upsertSession({ project, sessionId: sid, running: true, title: t.slice(0, 60), updatedAt: Date.now() })
        select(project, sid)
      }
      const r = await sendCommand('', project, sid, { op: 'prompt', text: t, mode: 'StartOrSteer' })
      if (r.ok && r.routed === 'Rejected') {
        // 过期 turnId 插话被宿主拒（routed 字段曾无人消费——假成功清空输入，审阅 P2-4）
        setErr('插话未送达（会话已切换轮次）——内容已保留，请重试')
        return
      }
      if (r.ok) {
        setText('')
        appendUser(sid, t)
      } else {
        // G3 冒烟缺口：发送失败此前静默吞（输入不清空、无提示）——红字展示宿主错误
        setErr(String(r.error ?? '发送失败'))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  // —— takeover 一次性守卫 ref（Hook 规则：无条件置顶——审批/单选帧从无到有时若在
  // 条件分支内新增 useRef 会触发 React #310 崩溃，G3 审批实测踩响）；
  // takeover 卸载（resolved）即复位——下次审批到达可再次应答 ——
  const decidedRef = useRef(false)
  const pickedRef = useRef(false)
  useEffect(() => {
    if (view?.approval == null) decidedRef.current = false
    if (view?.askSelect == null) pickedRef.current = false
  }, [view?.approval, view?.askSelect])

  // —— 审批 takeover：挂起时替代输入区（一 shot；resolved 帧到达自动卸载） ——
  if (view?.approval != null && sessionId !== null) {
    const a = view.approval
    const sensitive = a.kind === 'sensitive'
    const answer = async (decision: string): Promise<void> => {
      if (decidedRef.current) return
      decidedRef.current = true
      try {
        await sendCommand('', project ?? '', sessionId, { op: 'approval/respond', requestId: a.requestId, decision })
      } catch {
        decidedRef.current = false // 网络失败复位一次性守卫（曾吞错后面板点击永久无效干等超时）
      }
    }
    return (
      <div className="border-t border-amber-900/50 bg-amber-950/20 px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
            <ShieldAlert size={14} />
            {sensitive ? '敏感操作确认（不可记住）' : '需要审批'}
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">{a.tool}</span>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-neutral-800 bg-neutral-900/70 px-3 py-2 text-xs text-neutral-300">{a.preview}</pre>
          <div className="flex flex-wrap gap-2">
            {a.decisions.includes('once') && (
              <button onClick={() => void answer('once')} className="flex min-h-11 items-center gap-1.5 rounded bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-600">
                <Check size={13} /> 允许
              </button>
            )}
            {a.decisions.includes('always') && !sensitive && (
              <button onClick={() => void answer('always')} className="flex min-h-11 items-center gap-1.5 rounded bg-neutral-700 px-4 py-2 text-xs text-neutral-300 hover:bg-neutral-600">
                <Check size={13} /> 本会话始终允许
              </button>
            )}
            <button onClick={() => void answer('reject')} className="flex min-h-11 items-center gap-1.5 rounded bg-red-800 px-4 py-2 text-xs font-medium text-white hover:bg-red-700">
              <Ban size={13} /> 拒绝
            </button>
          </div>
        </div>
      </div>
    )
  }

  // —— askSelect takeover（单选面板） ——
  if (view?.askSelect != null && sessionId !== null) {
    const q = view.askSelect
    const answer = async (choice: string | null): Promise<void> => {
      if (pickedRef.current) return
      pickedRef.current = true
      try {
        await sendCommand('', project ?? '', sessionId, { op: 'askSelect/respond', requestId: q.requestId, choice })
      } catch {
        pickedRef.current = false
      }
    }
    return (
      <div className="border-t border-neutral-800 bg-neutral-900/50 px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-2">
          <div className="text-xs font-medium text-neutral-300">{q.title}</div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => (
              <button key={o} onClick={() => void answer(o)} className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500">
                {o}
              </button>
            ))}
            <button onClick={() => void answer(null)} className="rounded px-3 py-1.5 text-xs text-neutral-600 hover:text-neutral-400">
              取消
            </button>
          </div>
        </div>
      </div>
    )
  }

  // —— 常态输入区（未选项目=禁用占位；hero 态=「输入即开新对话」） ——
  const noProject = project === null
  return (
    <div className="border-t border-neutral-800 px-4 py-3">
      {err !== '' && <div className="mx-auto mb-2 max-w-3xl text-xs text-red-400">⚠ {err}</div>}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          value={text}
          disabled={noProject}
          onChange={(e) => {
            setText(e.target.value)
            if (err !== '') setErr('')
          }}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => (composingRef.current = false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder={noProject ? '先选择左侧项目，或点侧栏「+」添加…' : sessionId === null ? '输入即开新对话…（Shift+Enter 换行）' : running ? '运行中——输入将作为插话注入（Enter 排队）' : '输入你的问题…（Shift+Enter 换行）'}
          className="flex-1 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-50"
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={() => void submit()}
            disabled={text.trim() === '' || sending || noProject}
            className="rounded-lg bg-neutral-200 px-3.5 py-2 text-sm font-medium text-neutral-900 disabled:opacity-30"
          >
            {sessionId !== null && running ? '插话' : '发送'}
          </button>
          {sessionId !== null && view !== undefined && view.queue.length > 0 && (
            <button
              onClick={() => void sendCommand('', project ?? '', sessionId, { op: 'interjection/clear' }).catch(() => {})}
              className="flex items-center gap-1 rounded-lg border border-neutral-800 px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-300"
              title="清空插话队列"
            >
              <Trash2 size={11} /> 清队列({view.queue.length})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
