/**
 * 流式灰字折叠（M2 方案 A，第 2b 步 / TUI 规范 §4.12；M14-V2 物理行化）。
 *
 * 流式期灰字占位超过阈值行数时，只显示**尾部 N 行**（最新生成，用户看当前输出）
 * + 顶部提示折叠掉的行数，避免长输出占满动态区挡住历史。commit 后 Markdown 全量重渲染。
 *
 * M14-V2：带 width 时走 foldLines 物理行折叠——超长单行（minified JSON/长 URL）
 * 逻辑一行可爆几十物理行，按逻辑行切不看宽度是流式区超屏源头之一（§0.3）。
 * 无 width 时保持逻辑行旧行为（兼容无视口上下文的调用方）。
 *
 * 2026-09-02 批2a（P1-A RSS 膨胀主源）：增量化——旧路径每 delta 对**全文**重跑
 * wrap-ansi（O(n²)：25KB 文本 ×40 delta/s ≈ 每秒 MB 级字符串垃圾，真机客户端 20 分钟
 * 涨到 1.15-1.3G）。增量事实依据：贪心断行下**已产出的物理行不受后续 append 影响**
 * （行内容只依赖从行首起的一段源文——wrap-ansi 行为钉子测试防版本漂移），故缓存
 * 「稳定物理行+已消费偏移+未稳定尾段」，每 delta 只 wrap 新增字符——成本
 * O(width+delta)，与文本总长无关。缓存契约：仅可用于**同一 append-only 文本流**
 * （组件实例级 useRef 持有）；width 变化或长度回缩（非 append）时自动整体重算。
 */
import wrapAnsi from 'wrap-ansi'
import { foldLines } from './viewport.js'

/** 流式灰字最多显示的行数（尾部）；最小 Static 方案压到 3（详设 §3） */
export const STREAM_MAX_LINES = 3

export interface FoldedStream {
  /** 实际显示的行（尾部 maxLines 行，或全部） */
  lines: string[]
  /** 被折叠掉的行数（头部），0 表示未折叠 */
  folded: number
  /** 总行数 */
  total: number
}

/** 增量折叠缓存（调用方 useRef 持 box；契约见模块头注释） */
export interface StreamFoldCache {
  width: number
  /** 已稳定物理行（含已完成逻辑行全部物理行 + 进行中逻辑行的稳定前缀） */
  stable: string[]
  /** stable 已覆盖到的源字符偏移 */
  consumed: number
  /** 进行中未稳定尾段源文（≈最后一个物理行，长度约 < 两倍宽度） */
  pending: string
}

/** ref 形态缓存容器（{ current } box——组件 useRef 直传，函数内可初始化/失效重建） */
export type StreamFoldCacheBox = { current: StreamFoldCache | null }

/** 单条逻辑行 wrap（与 foldLines 同参：hard 断长 token、trim:false 保留缩进；空行=单个空行） */
function wrapSeg(seg: string, width: number): string[] {
  return seg === '' ? [''] : wrapAnsi(seg, width, { hard: true, trim: false }).split('\n')
}

/**
 * 把流式文本折叠成尾部 N 行 + 折叠计数。
 * 行按 `\n` 切分；不超过 maxLines 时原样返回。
 * width 提供时先按显示宽度 wrap 再切窗（物理行——M14-V2）；cache 提供时走增量路径
 * （结果与无 cache 全量折叠逐行一致——等价性测试钉死），否则整文折叠（一次性调用方）。
 */
export function foldStreamText(
  text: string,
  maxLines: number = STREAM_MAX_LINES,
  width?: number,
  cache?: StreamFoldCacheBox,
): FoldedStream {
  if (width !== undefined && Number.isFinite(width) && width >= 1) {
    if (cache !== undefined) return foldIncremental(text, maxLines, Math.floor(width), cache)
    const r = foldLines(text, maxLines, width, 'tail')
    return { lines: r.visible, folded: r.foldedCount, total: r.totalPhysical }
  }
  const allLines = text.split('\n')
  const total = allLines.length
  if (total <= maxLines) {
    return { lines: allLines, folded: 0, total }
  }
  return {
    lines: allLines.slice(total - maxLines),
    folded: total - maxLines,
    total,
  }
}

/** 增量路径（见模块头注释）。宁可重算不可错窗口：换宽/长度回缩自动重建。 */
function foldIncremental(text: string, maxLines: number, width: number, box: StreamFoldCacheBox): FoldedStream {
  let c = box.current
  if (c === null || c.width !== width || text.length < c.consumed + c.pending.length) {
    c = box.current = { width, stable: [], consumed: 0, pending: '' }
  }
  const rest = text.slice(c.consumed + c.pending.length)
  let pending = c.pending + rest
  // 消化完整逻辑行（后随 \n——整行的物理行即刻稳定）
  let ni = pending.indexOf('\n')
  while (ni >= 0) {
    for (const pl of wrapSeg(pending.slice(0, ni), width)) c.stable.push(pl)
    c.consumed += ni + 1
    pending = pending.slice(ni + 1)
    ni = pending.indexOf('\n')
  }
  // 进行中逻辑行：wrap 后除末行外提升为稳定（末行会被后续 append 改写，留在 pending）
  const w = wrapSeg(pending, width)
  const promote = w.slice(0, -1)
  const promoteLen = promote.join('').length
  for (const pl of promote) c.stable.push(pl)
  c.consumed += promoteLen
  c.pending = pending.slice(promoteLen)

  // 全量口径对齐：split('\n') 恒有末段（可能为 ''——仍占 1 物理行），pending 即末段，
  // 故 total = stable + 1 恒成立（含 text === '' 的初始态：单空行）
  const total = c.stable.length + 1
  const all = [...c.stable, c.pending]
  if (total <= maxLines) return { lines: all, folded: 0, total }
  return { lines: all.slice(all.length - maxLines), folded: total - maxLines, total }
}
