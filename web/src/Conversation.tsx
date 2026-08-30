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
import { useApp, type ChatEntry, type ChatImage, type ToolItem } from './store'

/** markdown 渲染（GFM 表格/删除线/任务单；手写暗色样式——prose 插件重，YAGNI）。
 *  流式 partial markdown 同渲（react-markdown 对不完整语法宽容降级）。 */
function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="break-words text-sm leading-relaxed [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-700 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-400 [&_code]:rounded [&_code]:bg-neutral-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-neutral-900 [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-neutral-800 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-neutral-800 [&_th]:bg-neutral-900 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
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
          <img src={`data:${im.mediaType};base64,${im.data}`} alt="" className="max-h-60 max-w-full rounded border border-neutral-700" />
        </a>
      ))}
    </div>
  )
}
function ToolCard({ project, sessionId, item }: { project: string; sessionId: string; item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false)
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
    <div className="rounded border border-neutral-800 bg-neutral-900/60">
      <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} className="text-neutral-500" /> : <ChevronRight size={13} className="text-neutral-500" />}
        <Terminal size={13} className="text-neutral-500" />
        <span className="text-xs text-neutral-300">{item.name}</span>
        <span className={`text-xs ${color}`}>{mark}</span>
        {item.summary !== undefined && item.summary !== '' && <span className="truncate text-xs text-neutral-600">{item.summary}</span>}
        {item.truncated === true && item.fullLoaded !== true && <span className="shrink-0 text-[10px] text-amber-600">已截断</span>}
      </button>
      {open && item.content !== undefined && (
        <pre className="max-h-72 overflow-auto border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-neutral-400">{item.content}</pre>
      )}
    </div>
  )
}

/** 单行渲染（memo：entries 增量追加时旧行引用稳定则跳过重渲——W-2 虚拟化的行经济） */
const EntryRow = memo(function EntryRow({ e }: { e: ChatEntry }): JSX.Element {
  if (e.kind === 'user') {
    return (
      <div className="ml-auto max-w-[85%] space-y-1.5 rounded-lg bg-neutral-800 px-3 py-2">
        {e.images !== undefined && e.images.length > 0 && <Images images={e.images} />}
        {e.text !== '' && <Markdown text={e.text} />}
      </div>
    )
  }
  if (e.kind === 'assistant') {
    return (
      <div className="max-w-[95%] text-neutral-200">
        <Markdown text={e.text} />
      </div>
    )
  }
  if (e.kind === 'tool') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 rounded border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-500">
          <Terminal size={12} className="shrink-0 text-neutral-600" />
          <span className="text-neutral-400">{e.name}</span>
          <span className={e.ok === false ? 'text-red-400' : 'text-emerald-500'}>{e.ok === false ? '✗' : '✓'}</span>
          {e.text !== '' && <span className="truncate">{e.text}</span>}
        </div>
        {e.images !== undefined && e.images.length > 0 && <Images images={e.images} />}
      </div>
    )
  }
  return (
    <div className={`rounded border px-2.5 py-1.5 text-xs ${e.error === true ? 'border-red-900/60 bg-red-950/20 text-red-400' : 'border-neutral-800 text-neutral-500'}`}>
      {e.error === true ? '✗ ' : ''}
      {e.text}
    </div>
  )
})

const TailMarkdown = function TailMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="max-w-[95%] text-neutral-200">
      <Markdown text={text} />
      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
    </div>
  )
}

/** 行距（虚拟化行内边距替代原 space-y-3——VList 的行是独立元素） */
const ROW_PAD = 'mx-auto max-w-3xl pb-3'

export function Conversation({ project, sessionId }: { project: string; sessionId: string }): JSX.Element {
  const view = useApp((s) => s.views[sessionId])
  const loadHistory = useApp((s) => s.loadHistory)
  const setLoadError = useApp((s) => s.setLoadError)
  const retryLoad = useApp((s) => s.retryLoad)
  const listRef = useRef<VListHandle>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  // 历史补拉（选中且未加载时一次；断线重连后的补拉由 onReconnect 触发 select 重置 loaded）。
  // 冷会话须先 session/restore 拉起（宿主对冷会话仅 restore 放行——G3 冒烟实测缺口），再 read。
  // base 恒传 ''（同源相对 URL）——曾把项目路径当 base 传，fetch 被浏览器解析成 file:// 直接拒
  // （"Not allowed to load local resource"），请求根本没到 serve
  useEffect(() => {
    if (view?.loaded === true) return
    sendCommand('', project, sessionId, { op: 'session/restore', sessionId })
      .then((r) => {
        if (!r.ok) {
          setLoadError(sessionId, `会话拉起失败：${String(r.error ?? '未知错误')}`)
          return
        }
        return sendCommand('', project, sessionId, { op: 'session/read', sessionId }).then((r2) => {
          if (r2.ok) loadHistory(sessionId, r2.value)
          else setLoadError(sessionId, `历史读取失败：${String(r2.error ?? '未知错误')}`)
        })
      })
      .catch((e) => setLoadError(sessionId, e instanceof Error ? e.message : String(e)))
  }, [project, sessionId, view?.loaded, loadHistory, setLoadError])

  const entries = view?.entries ?? []
  const items = view?.items ?? []
  const streaming = view?.streaming ?? ''
  const queue = view?.queue ?? []

  // W-2：虚拟化行清单——entries + 活动工具卡 + 流式尾 + 排队行，全部进 VList（DOM 恒定只挂可视行）
  const rows = useMemo(() => {
    const nodes: Array<{ key: string; node: JSX.Element }> = []
    if (view?.loadError !== '') {
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
        node: <div className="pt-16 text-center text-sm text-neutral-600">新对话——在下方输入第一句话</div>,
      })
    }
    entries.forEach((e, i) => {
      nodes.push({ key: `e${i}`, node: <EntryRow e={e} /> })
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
          <div className="ml-auto max-w-[85%] rounded-lg border border-dashed border-neutral-700 bg-neutral-800/50 px-3 py-2 text-sm text-neutral-400">
            {q}
            <span className="ml-2 text-xs text-neutral-600">已排队</span>
          </div>
        ),
      })
    })
    return nodes
  }, [view?.loadError, entries, items, streaming, queue, project, sessionId, retryLoad])

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
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-neutral-700 bg-neutral-900/90 px-3 py-1 text-xs text-neutral-300 shadow hover:border-neutral-500"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  )
}
