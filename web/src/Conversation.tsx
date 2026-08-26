/**
 * M13-W6a 对话页·展示层：历史补拉渲染（session/read→entries）+ 流式 delta + 工具卡折叠 +
 * 队列预览。W6b 在底部加输入与审批 takeover。
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react'
import { sendCommand } from './connect'
import { useApp, type ToolItem } from './store'
import { emptyView } from './store'
import { Composer } from './Composer'

/** 流式/历史文本渲染（Streamdown W6a 后续接入——骨架先用等宽预格式，样式分层已留） */
function Markdown({ text }: { text: string }): React.JSX.Element {
  return <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{text}</pre>
}

function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const color = item.status === 'running' ? 'text-amber-400' : item.status === 'error' ? 'text-red-400' : 'text-emerald-400'
  const mark = item.status === 'running' ? '…' : item.status === 'error' ? '✗' : '✓'
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60">
      <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} className="text-neutral-500" /> : <ChevronRight size={13} className="text-neutral-500" />}
        <Terminal size={13} className="text-neutral-500" />
        <span className="text-xs text-neutral-300">{item.name}</span>
        <span className={`text-xs ${color}`}>{mark}</span>
        {item.summary !== undefined && item.summary !== '' && <span className="truncate text-xs text-neutral-600">{item.summary}</span>}
      </button>
      {open && item.content !== undefined && (
        <pre className="max-h-72 overflow-auto border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-neutral-400">{item.content}</pre>
      )}
    </div>
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

export function Conversation({ project, sessionId }: { project: string; sessionId: string }): React.JSX.Element {
  // 新会话（sessionId='' 占位）：空视图（loaded=true 不触发补拉；Composer isNew 路径发送后转正选中）
  const view = useApp((s) => (sessionId === '' ? { ...emptyView(), loaded: true } : s.views[sessionId]))
  const running = useApp((s) => s.sessions.find((x) => x.sessionId === sessionId)?.running ?? false)
  const loadHistory = useApp((s) => s.loadHistory)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 历史补拉（选中且未加载时一次；断线重连后的补拉由 onReconnect 触发 select 重置 loaded）。
  // 冷会话须先 session/restore 拉起（宿主对冷会话仅 restore 放行——G3 冒烟实测缺口），再 read
  useEffect(() => {
    if (sessionId === '' || view?.loaded === true) return
    sendCommand(project === '' ? '' : project, project, sessionId, { op: 'session/restore', sessionId })
      .then((r) => {
        if (!r.ok) {
          loadHistory(sessionId, [])
          return
        }
        return sendCommand(project === '' ? '' : project, project, sessionId, { op: 'session/read', sessionId }).then(
          (r2) => {
            loadHistory(sessionId, r2.ok ? r2.value : [])
          },
        )
      })
      .catch(() => loadHistory(sessionId, []))
  }, [project, sessionId, view?.loaded, loadHistory])

  // 自动滚底（新消息/流式推进时）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [view?.entries.length, view?.streaming, view?.items.length])

  if (view === undefined) return <div className="flex h-full items-center justify-center text-sm text-neutral-600">载入中…</div>

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-3">
          {view.entries.map((e, i) =>
            e.kind === 'user' ? (
              <div key={i} className="ml-auto max-w-[85%] rounded-lg bg-neutral-800 px-3 py-2">
                <Markdown text={e.text} />
              </div>
            ) : e.kind === 'assistant' ? (
              <div key={i} className="max-w-[95%] text-neutral-200">
                <Markdown text={e.text} />
              </div>
            ) : (
              <div key={i} className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-500">
                {e.text}
              </div>
            ),
          )}
          {view.items.length > 0 && (
            <div className="space-y-1.5">
              {view.items.map((it) => (
                <ToolCard key={it.id} item={it} />
              ))}
            </div>
          )}
          {view.streaming !== '' && (
            <div className="max-w-[95%] text-neutral-200">
              <Markdown text={view.streaming} />
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
            </div>
          )}
          {view.queue.length > 0 && (
            <div className="rounded border border-dashed border-neutral-800 px-3 py-1.5 text-xs text-neutral-600">
              排队中：{view.queue.map((q) => q.slice(0, 30)).join(' / ')}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {/* W6b：输入/审批/选择 takeover（approval 挂起时占据输入位） */}
      {/* W7 软键盘吸底：iOS Safari 的 visualViewport 收缩时 body 高度跟随（height 100% 不跟键盘） */}
      <KeyboardAware>
        <Composer project={project} sessionId={sessionId} running={running} />
      </KeyboardAware>
    </div>
  )
}
