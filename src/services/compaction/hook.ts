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
import type { HistoryLine, Message } from '../../core/types.js'
import { buildContextMessages } from '../../core/context.js'
import { estimateContextTokens } from '../tokenizer.js'
import { resolveContextWindow } from '../contextWindow.js'
import type { CompactionOrchestrator } from './orchestrator.js'

/** 阈值 buffer：effectiveWindow - 20000，留 land the plane 空间（system + 工具 + 输出）。 */
const THRESHOLD_BUFFER = 20000

/**
 * 构造 loop 的 onBeforeRequest hook。
 * @param onCompacted 压缩完成回调（正常轮触发时调；400 兜底由 loop 自己调 opts.onCompacted）
 */
export function makeOnBeforeRequest(
  orchestrator: CompactionOrchestrator,
  provider: LLMProvider,
  providerReq: ProviderReq,
  system: string,
  onCompacted: (messages: HistoryLine[]) => void,
): (messages: HistoryLine[], trigger?: 'pressure' | 'overflow') => Promise<Message[]> {
  return async (messages, trigger = 'pressure') => {
    let ctx = buildContextMessages(messages)
    const ctxWindow = await resolveContextWindow(providerReq.model, providerReq.contextWindow)
    const effectiveWindow = Math.floor(ctxWindow * 0.9)
    const threshold = effectiveWindow - THRESHOLD_BUFFER
    const estimated = estimateContextTokens(system, ctx)

    // overflow（400 兜底）强制压缩；pressure 超阈才压缩
    if (trigger === 'overflow' || estimated > threshold) {
      const compacted = await orchestrator.run({
        trigger,
        messages: ctx,
        tokenCount: estimated,
        effectiveWindow,
        allMessages: messages,
        provider,
        providerReq,
      })
      if (compacted) {
        onCompacted(messages) // boundary 已追加，通知 UI 重建 committed
        ctx = buildContextMessages(messages) // 压缩后重新投影
      }
    }
    return ctx
  }
}
