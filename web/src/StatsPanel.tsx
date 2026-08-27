/**
 * M14-C4④ 用量面板（/stats web 对等）：侧栏入口弹出——汇总四维 token/成本/命中率/MCP +
 * 按天/按模型/按项目分布。数据来自 /api/stats（daemon 本机聚合，与 TUI /stats 同源）。
 * 打开时拉一次（不轮询——统计是回看视角非实时仪表盘）。
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { fetchStats, type StatsPayload } from './connect'

const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const fmtCny = (n: number): string => (n >= 1 ? `¥${n.toFixed(2)}` : n > 0 ? `¥${n.toFixed(4)}` : '¥0')

export function StatsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<StatsPayload | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    fetchStats('', 7)
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <span className="text-sm font-medium">用量统计（近 7 天）</span>
          <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {err !== '' && <div className="text-xs text-red-400">⚠ {err}</div>}
          {data === null && err === '' && <div className="py-8 text-center text-sm text-neutral-600">载入中…</div>}
          {data !== null && (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                <div className="rounded border border-neutral-800 p-2">
                  <div className="text-neutral-600">输入</div>
                  <div className="pt-0.5 font-mono text-sm text-neutral-200">{fmtTokens(data.totals.input)}</div>
                </div>
                <div className="rounded border border-neutral-800 p-2">
                  <div className="text-neutral-600">输出</div>
                  <div className="pt-0.5 font-mono text-sm text-neutral-200">{fmtTokens(data.totals.output)}</div>
                </div>
                <div className="rounded border border-neutral-800 p-2">
                  <div className="text-neutral-600">缓存命中</div>
                  <div className="pt-0.5 font-mono text-sm text-emerald-400">{(data.cacheHitRate * 100).toFixed(1)}%</div>
                </div>
                <div className="rounded border border-neutral-800 p-2">
                  <div className="text-neutral-600">成本</div>
                  <div className="pt-0.5 font-mono text-sm text-amber-400">{fmtCny(data.totals.costCny)}</div>
                </div>
              </div>
              <div className="text-[11px] text-neutral-600">
                {data.sessions} 个会话 · MCP 调用 {data.mcpCalls} 次
                {data.costUnknownSessions > 0 ? ` · ${data.costUnknownSessions} 个会话部分成本未收录定价` : ''}
              </div>
              {data.byModel.length > 0 && (
                <div>
                  <div className="pb-1 text-[11px] uppercase tracking-wider text-neutral-600">按模型</div>
                  <div className="space-y-1">
                    {data.byModel.map((m) => (
                      <div key={m.model} className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1 text-xs">
                        <span className="truncate font-mono text-neutral-300">{m.model}</span>
                        <span className="ml-auto shrink-0 text-neutral-600">
                          in {fmtTokens(m.input)} / out {fmtTokens(m.output)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-amber-500">{fmtCny(m.costCny)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {data.byDay.length > 0 && (
                <div>
                  <div className="pb-1 text-[11px] uppercase tracking-wider text-neutral-600">按天</div>
                  <div className="space-y-1">
                    {[...data.byDay].reverse().map((d) => (
                      <div key={d.date} className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1 text-xs">
                        <span className="font-mono text-neutral-400">{d.date}</span>
                        <span className="text-neutral-600">{d.sessions} 会话</span>
                        <span className="ml-auto text-neutral-600">
                          in {fmtTokens(d.input)} / out {fmtTokens(d.output)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-amber-500">{fmtCny(d.costCny)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {data.byProject.length > 0 && (
                <div>
                  <div className="pb-1 text-[11px] uppercase tracking-wider text-neutral-600">按项目</div>
                  <div className="space-y-1">
                    {data.byProject.slice(0, 5).map((p) => (
                      <div key={p.project} className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1 text-xs">
                        <span className="truncate text-neutral-300" title={p.project}>
                          {p.project.split('/').filter(Boolean).slice(-2).join('/')}
                        </span>
                        <span className="ml-auto shrink-0 text-neutral-600">
                          in {fmtTokens(p.input)} / out {fmtTokens(p.output)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-amber-500">{fmtCny(p.costCny)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
