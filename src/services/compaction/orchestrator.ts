/**
 * 压缩编排器（M5 §3.1）。
 *
 * 职责：
 *   - 注册策略，按 cost 递增排序（free 先于 llm，便宜的先试）
 *   - 触发时遍历策略：shouldRun=true 就 run，拿到 result 构造 boundary 追加到 allMessages
 *
 * ★ 投影派存储副作用集中在此：编排器追加 boundary 到 allMessages（旧消息不删），
 *   策略只调 LLM 摘要 + 切分计算（不碰存储）。loop 不做 length=0;push。
 *
 * boundary 是投影锚点：buildContextMessages（§7.2）识别最后一个 boundary，返回 summary+tail。
 */

import { isBoundary, type BoundaryLine, type HistoryLine } from '../../core/types.js'
// re-export：boundary 类型集中在 core/types（避免 core/context → services 依赖），orchestrator 转出方便外部用
export type { BoundaryLine, HistoryLine } from '../../core/types.js'
export { isBoundary } from '../../core/types.js'
import type { CompactionStrategy, CompactionContext } from './strategy.js'

/** 编排器入参 = 策略上下文 + 全量 messages（追加 boundary 的目标）。 */
export interface OrchestratorOptions extends CompactionContext {
  /** 全量 messages（含历史 boundary）；编排器追加新 boundary 到此 */
  allMessages: HistoryLine[]
}

export class CompactionOrchestrator {
  private readonly strategies: CompactionStrategy[] = []

  register(s: CompactionStrategy): void {
    this.strategies.push(s)
  }

  /**
   * 触发压缩：按 cost 排序遍历策略，首个产出 compacted:result 的策略执行。
   * 拿到 summary/tailStartIndex 后构造 boundary 追加到 allMessages（投影派，旧消息不删）。
   * @returns 是否执行了压缩（追加 boundary）
   */
  async run(opts: OrchestratorOptions): Promise<boolean> {
    if (this.strategies.length === 0) return false

    // 滚动 summary：显式传入优先，否则从 allMessages 找最后一个 boundary
    const previousSummary = opts.previousSummary ?? findLastSummary(opts.allMessages)
    const sorted = [...this.strategies].sort((a, b) => costRank(a.cost) - costRank(b.cost))

    for (const s of sorted) {
      const ctx: CompactionContext = { ...opts, previousSummary }
      if (!s.shouldRun(ctx)) continue
      const result = await s.run(ctx)
      if (result.compacted && result.summary != null && result.tailStartIndex != null) {
        const boundary: BoundaryLine = {
          compact_boundary: true,
          summary: result.summary,
          tailStartIndex: result.tailStartIndex,
          preTokens: result.preTokens ?? opts.tokenCount,
        }
        opts.allMessages.push(boundary) // 投影派：追加 boundary，旧消息留在前面不删
        return true
      }
      // 本策略未产出（compacted:false）→ 继续试下一个更贵的策略
    }
    return false
  }
}

/** cost → 排序权重（free=0 先试，llm=1 后试；便宜的先跑）。 */
function costRank(cost: 'free' | 'llm'): number {
  return cost === 'free' ? 0 : 1
}

/** 从 history lines 找最后一个 boundary 的 summary（滚动更新用）。 */
export function findLastSummary(lines: HistoryLine[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (isBoundary(line)) return line.summary
  }
  return undefined
}
