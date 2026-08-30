/**
 * 性能基准页（dev-only，?perf=1 进入）。
 * 三方案同数据对比流式渲染成本：baseline（全文重渲=现状）/ blocks（分块冻结，尾块 live）/ virtual（virtua + 分块）。
 * 指标：DOM 节点数、流式窗口 longtask 总耗时、React commit 次数（Profiler onRender 计数）。
 * 结果写 window.__perf（数组，每模式一条），Playwright 读取断言。
 */
import { memo, Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VList } from 'virtua'
import { marked } from 'marked'

type Entry = { id: number; kind: 'user' | 'assistant' | 'tool'; text: string }

/** 造一条合成 assistant 文本：段落 + 代码块 + 段落 */
function assistantText(seed: number): string {
  const code = Array.from({ length: 12 }, (_, i) => `const v${i} = compute(${seed}, ${i})`).join('\n')
  return `这是第 ${seed} 条助手回复。用于流式渲染性能对比的合成段落，包含中文与 **加粗** 以及行内 code。\n\n\`\`\`ts\n${code}\n\`\`\`\n\n收尾段落：结论 R${seed}，说明性能对比场景下的稳定文本块。`
}

/** 合成会话：n 组（用户→工具→助手） */
function makeEntries(n: number): Entry[] {
  const entries: Entry[] = []
  let id = 0
  for (let i = 0; i < n; i++) {
    entries.push({ id: id++, kind: 'user', text: `第 ${i} 个问题：帮我看看这块的实现？` })
    entries.push({ id: id++, kind: 'tool', text: `read_file src/module-${i}.ts` })
    entries.push({ id: id++, kind: 'assistant', text: assistantText(i) })
  }
  return entries
}

/** 分块：marked.lexer 顶层块切分（返回原始文本段） */
function splitBlocks(text: string): string[] {
  return marked.lexer(text).map((t) => t.raw)
}

/** 流式分块 markdown：稳定块按长度键控 memo（内容不变则跳过重渲），仅尾块重渲 */
const FrozenBlock = memo(function FrozenBlock({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
})
function BlockMarkdown({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => splitBlocks(text), [text])
  return (
    <>
      {blocks.map((b, i) =>
        i === blocks.length - 1 ? <TailBlock key={`t${i}`} text={b} /> : <FrozenBlock key={`f${i}-${b.length}`} text={b} />,
      )}
    </>
  )
}
const TailBlock = function TailBlock({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
}

/** 行渲染。assistant 行在 blocks/virtual 模式走 BlockMarkdown（分块冻结），baseline 走全文 ReactMarkdown */
const Row = memo(function Row({ e, useBlocks }: { e: Entry; useBlocks: boolean }): JSX.Element {
  if (e.kind === 'user') {
    return <div style={{ background: '#262626', borderRadius: 8, padding: '6px 10px', margin: '6px 0', marginLeft: 'auto', maxWidth: '85%' }}>{e.text}</div>
  }
  if (e.kind === 'tool') {
    return (
      <div style={{ border: '1px solid #262626', borderRadius: 6, padding: '4px 8px', margin: '4px 0', fontSize: 12, color: '#a3a3a3' }}>
        ⚙ {e.text} <span style={{ color: '#10b981' }}>✓</span>
      </div>
    )
  }
  return (
    <div style={{ margin: '6px 0', color: '#e5e5e5' }}>
      {useBlocks ? <BlockMarkdown text={e.text} /> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.text}</ReactMarkdown>}
    </div>
  )
})

type Mode = 'baseline' | 'blocks' | 'virtual'

const TOTAL_GROUPS = 150 // 450 行
const STREAM_TICKS = 120
const STREAM_INTERVAL_MS = 50

export function PerfBench(): JSX.Element {
  const [mode, setMode] = useState<Mode>('baseline')
  const [entries, setEntries] = useState<Entry[]>(() => makeEntries(TOTAL_GROUPS))
  const [running, setRunning] = useState<Mode | null>(null)
  const [results, setResults] = useState<Array<Record<string, number | string>>>([])
  const commitCount = useRef(0)
  const longTasks = useRef(0)
  const observerRef = useRef<PerformanceObserver | null>(null)

  const onRender = useCallback(() => {
    if (running !== null) commitCount.current++
  }, [running])

  const startStream = useCallback(async (m: Mode): Promise<Record<string, number | string>> => {
    setMode(m)
    setEntries(makeEntries(TOTAL_GROUPS))
    commitCount.current = 0
    longTasks.current = 0
    const mountT0 = performance.now()
    setRunning(m)
    setEntries(makeEntries(TOTAL_GROUPS))
    // 等双 rAF = 首屏挂载+布局完成
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const mountMs = Math.round(performance.now() - mountT0)
    await new Promise((r) => setTimeout(r, 500))

    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.current += e.duration
    })
    observer.observe({ entryTypes: ['longtask'] })
    observerRef.current = observer
    const obsStart = performance.now()

    // 模拟流式：向最后一条 assistant 追加内容
    let last = ''
    const frameTimes: number[] = []
    for (let i = 0; i < STREAM_TICKS; i++) {
      last += `流式增量第 ${i} 段，包含代码 \`(v${i})\` 与中文文本。`
      setEntries((prev) => {
        const copy = prev.slice()
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: assistantText(TOTAL_GROUPS - 1) + '\n\n' + last }
        return copy
      })
      const ft0 = performance.now()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      frameTimes.push(performance.now() - ft0)
      const wait = STREAM_INTERVAL_MS - (performance.now() - ft0)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
    frameTimes.sort((a, b) => a - b)
    const avgFrame = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length)
    const p95Frame = frameTimes[Math.floor(frameTimes.length * 0.95)] ?? 0
    setRunning(null)
    observer.disconnect()
    const streamMs = performance.now() - obsStart
    await new Promise((r) => setTimeout(r, 200))
    const domNodes = document.getElementsByTagName('*').length
    return {
      mode: m,
      mountMs,
      avgFrame: Math.round(avgFrame * 10) / 10,
      p95Frame: Math.round(p95Frame * 10) / 10,
      streamMs: Math.round(streamMs),
      longtaskMs: Math.round(longTasks.current),
      commits: commitCount.current,
      domNodes,
    }
  }, [])

  const runAll = useCallback(async (): Promise<void> => {
    const out: Array<Record<string, number | string>> = []
    for (const m of ['baseline', 'blocks', 'virtual'] as Mode[]) {
      setEntries([]) // 卸载上一次的树
      await new Promise((r) => setTimeout(r, 300))
      const r = await startStream(m)
      out.push(r)
      setResults([...out])
      await new Promise((r) => setTimeout(r, 300))
    }
    ;(window as unknown as { __perf: unknown }).__perf = out
  }, [startStream])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  const useBlocks = mode !== 'baseline'
  const list = useMemo(() => {
    if (mode === 'virtual') {
      return (
        <VList style={{ height: '100%' }}>
          {entries.map((e) => (
            <Row key={e.id} e={e} useBlocks={useBlocks} />
          ))}
        </VList>
      )
    }
    return (
      <>
        {entries.map((e) => (
          <Row key={e.id} e={e} useBlocks={useBlocks} />
        ))}
      </>
    )
  }, [entries, mode, useBlocks])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', color: '#e5e5e5', fontFamily: 'monospace' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #262626', display: 'flex', gap: 12, alignItems: 'center' }}>
        <strong>PerfBench</strong>
        <span>{entries.length} 行 · 流式 {STREAM_TICKS} tick × {STREAM_INTERVAL_MS}ms</span>
        <button onClick={() => void runAll()} disabled={running !== null} style={{ padding: '4px 12px' }}>
          {running !== null ? `运行中: ${running}` : 'RUN ALL 三方案'}
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12 }}>
          {results.map((r) => (
            <span key={String(r.mode)} style={{ marginRight: 12 }}>
              [{String(r.mode)}] stream {r.streamMs}ms · longtask {r.longtaskMs}ms · commits {r.commits} · DOM {r.domNodes}
            </span>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px' }}>
        <Profiler id={`list-${mode}-${running ?? 'idle'}`} onRender={onRender}>
          {list}
        </Profiler>
      </div>
    </div>
  )
}
