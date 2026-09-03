/**
 * M13-W6a 对话页：历史补拉渲染（session/read→entries）+ 流式 delta + 工具卡折叠 + 图片直渲。
 * 批 1（2026-08-30 W-2/W-10）：virtua VList 虚拟化会话流（长会话 DOM 恒定）+ 底部跟随/回到底部；
 * 排队插话行升级为用户气泡样式（与 TUI 留痕对齐）。
 * 输入区不在本组件——App 布局层常驻底部（composer 是 session-optional 常驻位，本组件只管滚动体）。
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VList, type VListHandle } from 'virtua'
import { sendCommand } from './connect'
import { parseDiffContent } from './diffView'
import { buildMessageActions, type MessageActionContext } from './messageActions'
import { useApp, type ChatEntry, type ChatImage, type ToolItem } from './store'

/** markdown 渲染（GFM 表格/删除线/任务单；手写暗色样式——prose 插件重，YAGNI）。
 *  流式 partial markdown 同渲（react-markdown 对不完整语法宽容降级）。 */
function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="break-words text-sm leading-relaxed [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-2 [&_blockquote]:text-dim [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-surface [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
/** 图片直渲（data URI 直渲——缩略图 max-h 限高防长图撑爆滚动体） */
function Images({ images }: { images: ChatImage[] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((im, i) => (
        <a key={i} href={`data:${im.mediaType};base64,${im.data}`} target="_blank" rel="noreferrer">
          <img src={`data:${im.mediaType};base64,${im.data}`} alt="" className="max-h-60 max-w-full rounded border border-line-strong" />
        </a>
      ))}
    </div>
  )
}
function ToolCard({ project, sessionId, item }: { project: string; sessionId: string; item: ToolItem }): JSX.Element {
  // 活动流 B5/D15：编辑工具卡默认展开 diff（三端「diff 直接可见不折叠」对齐——TUI Static 全量同语义）
  const [open, setOpen] = useState(item.name === 'edit_file' || item.name === 'write_file')
  const completeTool = useApp((s) => s.completeTool)
  // C1⑤ 补漏：截断帧（4KB）首次展开时拉 item/read 全文（1MB 上限；宿主 tool_use 配对）
  useEffect(() => {
    if (open && item.truncated === true && item.fullLoaded !== true) {
      sendCommand('', project, sessionId, { op: 'item/read', itemId: item.id })
        .then((r) => {
          if (r.ok && typeof (r.value as { content?: unknown }).content === 'string') {
            completeTool(sessionId, item.id, (r.value as { content: string }).content)
          }
        })
        .catch(() => {})
    }
  }, [open, item.truncated, item.fullLoaded, item.id, project, sessionId, completeTool])
  const color = item.status === 'running' ? 'text-amber-400' : item.status === 'error' ? 'text-red-400' : 'text-emerald-400'
  const mark = item.status === 'running' ? '…' : item.status === 'error' ? '✗' : '✓'
  return (
    <div className="rounded border border-line bg-surface/60">
      <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} className="text-muted" /> : <ChevronRight size={13} className="text-muted" />}
        <Terminal size={13} className="text-muted" />
        <span className="text-xs text-body">{item.name}</span>
        {item.status === 'running' && item.digest !== undefined && item.digest !== '' && (
          <span className="truncate text-xs text-amber-400">正在执行 {item.digest}</span>
        )}
        <span className={`text-xs ${color}`}>{mark}</span>
        {item.summary !== undefined && item.summary !== '' && <span className="truncate text-xs text-faint">{item.summary}</span>}
        {item.truncated === true && item.fullLoaded !== true && <span className="shrink-0 text-[10px] text-amber-600">已截断</span>}
      </button>
      {open && item.content !== undefined && <ToolOutput name={item.name} content={item.content} />}
    </div>
  )
}

/** 工具展开内容：编辑类工具（edit_file/write_file）渲染着色 diff（W-4），其余走原始 pre */
function ToolOutput({ name, content }: { name: string; content: string }): JSX.Element {
  const isEdit = name === 'edit_file' || name === 'write_file'
  const view = useMemo(() => (isEdit ? parseDiffContent(content) : null), [isEdit, content])
  if (view === null) {
    return <pre className="max-h-72 overflow-auto border-t border-line px-3 py-2 text-xs leading-relaxed text-dim">{content}</pre>
  }
  const kindClass: Record<string, string> = {
    file: 'text-dim font-semibold',
    hunk: 'text-sky-400',
    add: 'bg-emerald-950/60 text-emerald-300',
    del: 'bg-red-950/60 text-red-300',
    ctx: 'text-muted',
  }
  return (
    <div className="border-t border-line">
      {view.header !== '' && <div className="px-3 pt-2 text-xs text-muted">{view.header}</div>}
      <div className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {view.lines.map((l, i) => (
          <div key={i} className={kindClass[l.kind] ?? 'text-muted'}>
            {l.text === '' ? ' ' : l.text}
          </div>
        ))}
        {view.truncated && (
          <div className="pt-1 text-faint">…已截断，省略 {view.omitted} 行</div>
        )}
      </div>
    </div>
  )
}

/** 单行渲染（memo：entries 增量追加时旧行引用稳定则跳过重渲——W-2 虚拟化的行经济）。
 *  hover 操作条（W-5 注册表）：复制/重发等，行右上角浮现。 */
const EntryRow = memo(function EntryRow({ e, actionCtx }: { e: ChatEntry; actionCtx: MessageActionContext }): JSX.Element {
  const actions = buildMessageActions(e, actionCtx)
  if (e.kind === 'user') {
    return (
      <div className="group relative ml-auto max-w-[85%] space-y-1.5 rounded-lg bg-surface-raised px-3 py-2">
        {e.images !== undefined && e.images.length > 0 && <Images images={e.images} />}
        {e.text !== '' && <Markdown text={e.text} />}
        <ActionBar actions={actions} />
      </div>
    )
  }
  if (e.kind === 'assistant') {
    return (
      <div className="group relative max-w-[95%] text-bright">
        <Markdown text={e.text} />
        <ActionBar actions={actions} />
      </div>
    )
  }
  if (e.kind === 'tool') {
    return <ToolEntryRow e={e} actionCtx={actionCtx} />
  }
  return (
    <div className={`rounded border px-2.5 py-1.5 text-xs ${e.error === true ? 'border-red-900/60 bg-red-950/20 text-red-400' : 'border-line text-muted'}`}>
      {e.error === true ? '✗ ' : ''}
      {e.text}
    </div>
  )
})

/** 历史工具行（批 3 W-4）：点击展开完整结果——编辑类工具着色 diff（+/- 着色/超长截断），
 *  其余 pre；附着图照渲。open 态行内私有。 */
function ToolEntryRow({ e, actionCtx }: { e: ChatEntry; actionCtx: MessageActionContext }): JSX.Element {
  // R3/D15：历史编辑卡默认展开 diff（与运行卡同款——「最终呈现 diff 直接可见」三端对齐）
  const [open, setOpen] = useState(e.name === 'edit_file' || e.name === 'write_file')
  const isEdit = e.name === 'edit_file' || e.name === 'write_file'
  const view = useMemo(
    () => (open && isEdit && e.detail !== undefined ? parseDiffContent(e.detail) : null),
    [open, isEdit, e.detail],
  )
  const actions = buildMessageActions(e, actionCtx)
  return (
    <div className="space-y-1.5">
      <div className="group flex items-center gap-2 rounded border border-line px-2.5 py-1.5 text-xs text-muted">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />}
          <Terminal size={12} className="shrink-0 text-faint" />
          <span className="text-dim">{e.name}</span>
          <span className={e.ok === false ? 'text-red-400' : 'text-emerald-500'}>{e.ok === false ? '✗' : '✓'}</span>
          {e.text !== '' && <span className="truncate">{e.text}</span>}
        </button>
        <ActionBar actions={actions} />
      </div>
      {open && e.detail !== undefined && (
        <div className="pl-4">
          {view !== null ? (
            <div className="rounded border border-line">
              <div className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
                {view.lines.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.kind === 'add'
                        ? 'bg-emerald-950/60 text-emerald-300'
                        : l.kind === 'del'
                          ? 'bg-red-950/60 text-red-300'
                          : l.kind === 'hunk'
                            ? 'text-sky-400'
                            : l.kind === 'file'
                              ? 'text-dim font-semibold'
                              : 'text-muted'
                    }
                  >
                    {l.text === '' ? ' ' : l.text}
                  </div>
                ))}
                {view.truncated && <div className="pt-1 text-faint">…已截断，省略 {view.omitted} 行</div>}
              </div>
            </div>
          ) : (
            <pre className="max-h-72 overflow-auto rounded border border-line px-3 py-2 text-xs leading-relaxed text-dim">{e.detail}</pre>
          )}
        </div>
      )}
      {e.images !== undefined && e.images.length > 0 && <Images images={e.images} />}
    </div>
  )
}

/** W-5 行内操作条：hover 浮现（触屏常显成本高——先桌面优先） */
function ActionBar({ actions }: { actions: Array<{ key: string; label: string; title: string; run: () => void }> }): JSX.Element {
  return (
    <span className="absolute right-1.5 top-1.5 flex gap-1">
      {actions.map((a) => (
        <button
          key={a.key}
          onClick={() => a.run()}
          title={a.title}
          className="rounded border border-line-strong bg-surface/90 px-1.5 py-0.5 text-[10px] text-dim hover:text-bright"
        >
          {a.label}
        </button>
      ))}
    </span>
  )
}

const TailMarkdown = function TailMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="max-w-[95%] text-bright">
      <Markdown text={text} />
      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
    </div>
  )
}

/** 行距（虚拟化行内边距替代原 space-y-3——VList 的行是独立元素） */
const ROW_PAD = 'mx-auto max-w-3xl pb-3'

/** 活动流 B5：loading 细条——thinking 尾部摘要（滚动感）/ 最新执行 digest；轮运行中常驻 */
function LoadingStrip({ view }: { view: ReturnType<typeof useApp.getState>['views'][string] | undefined }): JSX.Element | null {
  if (view === undefined || view.loadError !== '') return null
  const running = view.items.find((it) => it.status === 'running')
  const busy = view.streaming !== '' || view.thinkingTail !== '' || running !== undefined
  if (!busy) return null
  const text =
    view.thinkingTail !== ''
      ? `思考中 ${view.thinkingTail.slice(-40)}…`
      : running?.digest !== undefined && running.digest !== ''
        ? `正在执行 ${running.digest}`
        : running !== undefined
          ? `正在执行 ${running.name}…`
          : '生成中…'
  return (
    <div className="border-t border-line px-4 py-1 text-xs text-faint">
      <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500 align-middle" />
      {text}
    </div>
  )
}

export function Conversation({ project, sessionId }: { project: string; sessionId: string }): JSX.Element {
  const view = useApp((s) => s.views[sessionId])
  const loadHistory = useApp((s) => s.loadHistory)
  const setLoadError = useApp((s) => s.setLoadError)
  const retryLoad = useApp((s) => s.retryLoad)
  const listRef = useRef<VListHandle>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  // 切会话重置底部跟随——上一个会话的上翻状态不应影响新会话的自动贴底
  useEffect(() => {
    atBottomRef.current = true
    setAtBottom(true)
  }, [sessionId])
  // 历史补拉（选中且未加载时一次；断线重连后的补拉由 onReconnect 触发 select 重置 loaded）。
  // 冷会话须先 session/restore 拉起（宿主对冷会话仅 restore 放行——G3 冒烟实测缺口），再 read。
  // base 恒传 ''（同源相对 URL）——曾把项目路径当 base 传，fetch 被浏览器解析成 file:// 直接拒
  // （"Not allowed to load local resource"），请求根本没到 serve
  useEffect(() => {
    // W-9：resync（重连基线 gap/seq 回绕）时无视 loaded 全量重拉——loadHistory 清标记
    if (view?.loaded === true && view?.resync !== true) return
    sendCommand('', project, sessionId, { op: 'session/restore', sessionId })
      .then((r) => {
        if (!r.ok) {
          setLoadError(sessionId, `会话拉起失败：${String(r.error ?? '未知错误')}`)
          return
        }
        return sendCommand('', project, sessionId, { op: 'session/read', sessionId }).then((r2) => {
          if (r2.ok) loadHistory(sessionId, r2.value)
          else setLoadError(sessionId, `历史读取失败：${String(r2.error ?? '未知错误')}`)
          // 二轮审阅（TUI 同构）：resync 只补 transcript 不对账运行态——断线窗口丢收尾帧时
          // 会话列表恒转圈；session/list 的 running 注入（宿主冷热合并）为权威值
          if (r2.ok) {
            void sendCommand('', project, sessionId, { op: 'session/list' })
              .then((r3) => {
                const mine = (Array.isArray(r3.value) ? (r3.value as Array<{ sessionId?: string; running?: boolean }>) : []).find((m) => m.sessionId === sessionId)
                if (mine !== undefined) useApp.getState().setSessionRunning(sessionId, mine.running === true)
              })
              .catch(() => {})
          }
        })
      })
      .catch((e) => setLoadError(sessionId, e instanceof Error ? e.message : String(e)))
  }, [project, sessionId, view?.loaded, view?.resync, loadHistory, setLoadError])

  const entries = view?.entries ?? []
  const items = view?.items ?? []
  const streaming = view?.streaming ?? ''
  const queue = view?.queue ?? []

  // W-5 操作上下文（稳定引用——行 memo 不因回调身份抖动而失效）
  const actionCtx = useMemo<MessageActionContext>(
    () => ({
      copy: (t) => {
        if (navigator.clipboard !== undefined) void navigator.clipboard.writeText(t).catch(() => {})
      },
      resend: (t) => {
        void sendCommand('', project, sessionId, { op: 'prompt', text: t, mode: 'StartOrSteer' })
          .then((r) => {
            if (r.ok) useApp.getState().appendUser(sessionId, t)
          })
          .catch(() => {})
      },
    }),
    [project, sessionId],
  )

  // W-2：虚拟化行清单——entries + 活动工具卡 + 流式尾 + 排队行，全部进 VList（DOM 恒定只挂可视行）
  const rows = useMemo(() => {
    const nodes: Array<{ key: string; node: JSX.Element }> = []
    if (view !== undefined && view.loadError !== '') {
      nodes.push({
        key: 'loaderror',
        node: (
          <div className="flex items-center gap-3 rounded border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs text-red-400">
            <span className="flex-1">⚠ {view?.loadError}</span>
            <button onClick={() => retryLoad(sessionId)} className="rounded border border-red-900 px-2 py-1 hover:text-red-200">
              重试
            </button>
          </div>
        ),
      })
    }
    if (entries.length === 0 && items.length === 0 && streaming === '' && view?.loadError === '') {
      nodes.push({
        key: 'empty',
        node: <div className="pt-16 text-center text-sm text-faint">新对话——在下方输入第一句话</div>,
      })
    }
    entries.forEach((e, i) => {
      nodes.push({ key: `e${i}`, node: <EntryRow e={e} actionCtx={actionCtx} /> })
    })
    items.forEach((it) => {
      nodes.push({ key: `t${it.id}`, node: <ToolCard project={project} sessionId={sessionId} item={it} /> })
    })
    if (streaming !== '') {
      nodes.push({ key: 'streaming', node: <TailMarkdown text={streaming} /> })
    }
    queue.forEach((q, i) => {
      // W-10：排队插话 = 用户气泡形态 + 已排队标记（与 TUI 留痕对齐）
      nodes.push({
        key: `q${i}`,
        node: (
          <div className="ml-auto max-w-[85%] rounded-lg border border-dashed border-line-strong bg-surface-raised/50 px-3 py-2 text-sm text-dim">
            {q}
            <span className="ml-2 text-xs text-faint">已排队</span>
          </div>
        ),
      })
    })
    return nodes
  }, [view?.loadError, entries, items, streaming, queue, project, sessionId, retryLoad, actionCtx])

  // 底部跟随：仅当用户本就在底部时，行清单变化（新消息/流式推进）滚到底
  useLayoutEffect(() => {
    if (atBottomRef.current && rows.length > 0) {
      listRef.current?.scrollToIndex(rows.length - 1, { align: 'end' })
    }
  }, [rows])

  const onScroll = (offset: number): void => {
    const el = listRef.current
    if (el === null) return
    const bottom = el.scrollOffset + el.viewportSize >= el.scrollSize - 24
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom
      setAtBottom(bottom)
    }
    void offset
  }

  const jumpToBottom = (): void => {
    atBottomRef.current = true
    setAtBottom(true)
    listRef.current?.scrollToIndex(rows.length - 1, { align: 'end' })
  }

  return (
    <div className="relative min-h-0 flex-1">
      <VList
        ref={listRef}
        onScroll={onScroll}
        style={{ height: '100%', padding: '12px 16px' }}
        bufferSize={600}
      >
        {rows.map((r) => (
          <div key={r.key} className={ROW_PAD}>
            {r.node}
          </div>
        ))}
      </VList>
      {/* 活动流 B5：loading 细条（用户点名对等——思考中 <tail> / 正在执行 <digest>；滚动体底部） */}
      <LoadingStrip view={view} />
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-surface/90 px-3 py-1 text-xs text-body shadow hover:border-line-strong"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  )
}
