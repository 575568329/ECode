/**
 * loop onBeforeRequest hook 工厂（M5 §6.2 接线核心）。
 *
 * 把编排器 + contextWindow + 投影 + 估算串成 loop 的 onBeforeRequest 闭包。
 * cli runOnce 和 TuiApp submit 共用（DRY）。
 *
 * 每轮 provider.run 前：投影 buildContextMessages → 估算 token → 超阈或 overflow
 *   → 编排器跑 summarize（追加 boundary 到 messages）→ 重新投影 → 返回子集喂 LLM。
 * messagesRef 全量不变（投影派），压缩副作用在编排器。
 */

import type { LLMProvider, ProviderReq } from '../../providers/interface.js'
import type { CompactionContext } from './strategy.js'
import type { HistoryLine, Message, ToolSpec } from '../../core/types.js'
import { buildContextMessages } from '../../core/context.js'
import { estimateContextTokens } from '../tokenizer.js'
import { resolveContextWindow } from '../contextWindow.js'
import type { CompactionOrchestrator } from './orchestrator.js'
import type { HistoryStore } from '../history.js'

/** 阈值 buffer：effectiveWindow - 20000，留 land the plane 空间（system + 工具 + 输出）。 */
const THRESHOLD_BUFFER = 20000
/** 有效窗口比（contextWindow × 0.9，留 headroom 给 system + 工具 + 输出）。 */
const EFFECTIVE_WINDOW_RATIO = 0.9

/** makeOnBeforeRequest 参数（v6 审阅：9 参再加 tools 收敛为 options 对象，AGENTS 1.3）。 */
export interface OnBeforeRequestOpts {
  /** 摘要 LLM 调用的中断信号（P1-5） */
  signal?: AbortSignal
  /** 压缩完成回调（hook 统一调，覆盖 pressure/overflow/手动三条路径） */
  onCompacted: (messages: HistoryLine[]) => void
  /** boundary 落盘句柄（P0-3：不传则只在内存，重启丢失） */
  history?: HistoryStore
  /** 压缩开始回调（UI 提示「正在压缩」——摘要可能数十秒） */
  onCompacting?: () => void
  /** 压缩未执行/失败回调（与 onCompacting 配对清提示） */
  onCompactFail?: () => void
  /**
   * 工具 specs（M6 v3 P1-1：MCP 工具 schema 也吃上下文，20+ 工具可达 15K+ token——
   * 不计入估算则压到 summary 仍可能 400）。传 toolReg.specs()。
   */
  tools?: ToolSpec[]
  /** M12-P0：摘要调用 usage 上报（透传到策略 ctx——压缩漏账修复） */
  onUsage?: CompactionContext['onUsage']
  /**
   * M13-B3（roles.summary 分流）：摘要专用 provider/req/窗口。缺省回退主模型（现状）。
   * 审阅 P0 修复：此前只拆窗口不换笔——装配链透传主会话 provider，分流完全失效。
   */
  summary?: { provider: LLMProvider; providerReq: ProviderReq; window: number }
}

/**
 * 构造 loop 的 onBeforeRequest hook（cli runOnce 与 TuiApp submit 共用）。
 */
export function makeOnBeforeRequest(
  orchestrator: CompactionOrchestrator,
  provider: LLMProvider,
  providerReq: ProviderReq,
  system: string,
  opts: OnBeforeRequestOpts,
): (messages: HistoryLine[], trigger?: 'pressure' | 'overflow' | 'manual') => Promise<Message[]> {
  return async (messages, trigger = 'pressure') => {
    let ctx = buildContextMessages(messages)
    const ctxWindow = await resolveContextWindow(providerReq.model, providerReq.contextWindow)
    const effectiveWindow = Math.floor(ctxWindow * EFFECTIVE_WINDOW_RATIO)
    const threshold = effectiveWindow - THRESHOLD_BUFFER
    const estimated = estimateContextTokens(system, ctx, opts.tools)

    // overflow（400 兜底/手动 /compact）强制压缩；pressure 超阈才压缩
    if (trigger === 'overflow' || estimated > threshold) {
      opts.onCompacting?.()
      const compacted = await orchestrator.run({
        trigger,
        messages: ctx,
        tokenCount: estimated,
        triggerWindow: effectiveWindow,
        summaryWindow: opts.summary !== undefined ? opts.summary.window : effectiveWindow,
        allMessages: messages,
        provider: opts.summary !== undefined ? opts.summary.provider : provider,
        providerReq: opts.summary !== undefined ? opts.summary.providerReq : providerReq,
        history: opts.history,
        signal: opts.signal,
        onUsage: opts.onUsage,
      })
      if (compacted) {
        opts.onCompacted(messages) // boundary 已追加，通知 UI 重建 committed
        ctx = buildContextMessages(messages) // 压缩后重新投影
      } else {
        opts.onCompactFail?.() // 未执行/失败（太短/摘要失败/熔断）——清掉「正在压缩」提示
      }
    }
    return ctx
  }
}
