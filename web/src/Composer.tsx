/**
 * M13-W6b 交互层：输入区（prompt 三态——新会话/插话 StartOrSteer/排队语义挂 W7 细化）+
 * 审批 composer-takeover（挂起时占据输入位——harness ApprovalPanel 同款模式；
 * sensitive 不给"始终允许"键）+ askSelect 单选 + 插话队列清空。
 * IME：isComposing 期间 Enter 不提交（中文输入法必踩）。
 */

import { useRef, useState } from 'react'
import { Ban, Check, ShieldAlert, Trash2 } from 'lucide-react'
import { sendCommand } from './connect'
import { useApp } from './store'

export function Composer({ project, sessionId, running }: { project: string; sessionId: string; running: boolean }): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const composingRef = useRef(false)
  const view = useApp((s) => s.views[sessionId])
  const select = useApp((s) => s.select)
  const upsertSession = useApp((s) => s.upsertSession)
  const loadHistory = useApp((s) => s.loadHistory)

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (t === '' || sending) return
    setSending(true)
    try {
      // 新会话（sessionId 为占位空串）：prompt 不带 sessionId=隐式建（三态③），回执带新 id 转正选中
      const isNew = sessionId === ''
      const r = await sendCommand('', project, isNew ? undefined : sessionId, { op: 'prompt', text: t, mode: 'StartOrSteer' })
      if (r.ok) {
        setText('')
        const sid = String(r.sessionId ?? '')
        if (isNew && sid !== '') {
          loadHistory(sid, [])
          upsertSession({ project, sessionId: sid, running: true, title: t.slice(0, 60), updatedAt: Date.now() })
          select(project, sid)
        }
      }
    } finally {
      setSending(false)
    }
  }

  // —— 审批 takeover：挂起时替代输入区（一 shot；resolved 帧到达自动卸载） ——
  if (view?.approval != null) {
    const a = view.approval
    const sensitive = a.kind === 'sensitive'
    const decided = useRef(false)
    const answer = async (decision: string): Promise<void> => {
      if (decided.current) return
      decided.current = true
      await sendCommand('', project, sessionId, { op: 'approval/respond', requestId: a.requestId, decision }).catch(() => {})
    }
    return (
      <div className="border-t border-amber-900/50 bg-amber-950/20 px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
            {sensitive ? <ShieldAlert size={14} /> : <ShieldAlert size={14} />}
            {sensitive ? '敏感操作确认（不可记住）' : '需要审批'}
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">{a.tool}</span>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-neutral-800 bg-neutral-900/70 px-3 py-2 text-xs text-neutral-300">{a.preview}</pre>
          <div className="flex flex-wrap gap-2">
            {a.decisions.includes('once') && (
              <button onClick={() => void answer('once')} className="flex items-center gap-1.5 rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
                <Check size={13} /> 允许
              </button>
            )}
            {a.decisions.includes('always') && !sensitive && (
              <button onClick={() => void answer('always')} className="flex items-center gap-1.5 rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-600">
                <Check size={13} /> 本会话始终允许
              </button>
            )}
            <button onClick={() => void answer('reject')} className="flex items-center gap-1.5 rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">
              <Ban size={13} /> 拒绝
            </button>
          </div>
        </div>
      </div>
    )
  }

  // —— askSelect takeover（单选面板） ——
  if (view?.askSelect != null) {
    const q = view.askSelect
    const picked = useRef(false)
    const answer = async (choice: string | null): Promise<void> => {
      if (picked.current) return
      picked.current = true
      await sendCommand('', project, sessionId, { op: 'askSelect/respond', requestId: q.requestId, choice }).catch(() => {})
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

  // —— 常态输入区 ——
  return (
    <div className="border-t border-neutral-800 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => (composingRef.current = false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder={running ? '运行中——输入将作为插话注入（Enter 排队）' : '输入你的问题…（Shift+Enter 换行）'}
          className="flex-1 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={() => void submit()}
            disabled={text.trim() === '' || sending}
            className="rounded-lg bg-neutral-200 px-3.5 py-2 text-sm font-medium text-neutral-900 disabled:opacity-30"
          >
            {running ? '插话' : '发送'}
          </button>
          {view !== undefined && view.queue.length > 0 && (
            <button
              onClick={() => void sendCommand('', project, sessionId, { op: 'interjection/clear' }).catch(() => {})}
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
