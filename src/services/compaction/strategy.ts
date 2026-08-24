/**
 * 压缩策略可插拔骨架（M5 §3.1）。
 *
 * 一种压缩手段 = 一个 CompactionStrategy 实现，注册到 orchestrator。
 * 加新策略 = 写新文件实现接口 + register，零改动现有代码（开闭原则）。
 *
 * 职责分层：
 *   - 策略 run：调 LLM 做摘要（LLM 副作用）+ 切分计算，返回 summary/tailStartIndex（不碰存储）
 *   - 编排器：调策略拿 result → 构造 boundary → 追加 allMessages + history（存储副作用集中）
 */

import type { LLMProvider, ProviderReq } from '../../providers/interface.js'
import type { Message } from '../../core/types.js'

/** 触发场景：阈值预防 / 400 反应式救场 / 手动 / 切换 model 预检。 */
export type CompactionTrigger = 'pressure' | 'overflow' | 'manual' | 'model-switch'

/** 传给策略的上下文（纯计算 + LLM 调用输入，不含存储句柄）。 */
export interface CompactionContext {
  /** 当前投影 context（喂 LLM 的子集，要压缩的） */
  messages: Message[]
  /** 当前 token 估算 */
  tokenCount: number
  /** 触发窗口（主模型 contextWindow × 0.9——压力阈值判定盯主模型，M13-B3 拆双字段） */
  triggerWindow: number
  /** 摘要窗口（摘要模型窗口——批预算与归并判定盯摘要模型；未分流时与 triggerWindow 同源） */
  summaryWindow: number
  trigger: CompactionTrigger
  /** 摘要要调的 LLM provider（策略用） */
  provider: LLMProvider
  /** 摘要用哪个 model 配置（沿用当前 provider 的 ProviderReq） */
  providerReq: ProviderReq
  /** 滚动 summary：上一次的摘要文本（多次压缩时回喂更新，避免摘要嵌套漂移） */
  previousSummary?: string
  /** AbortSignal（P1-5：摘要 LLM 调用可中断，透传 loop 的 signal） */
  signal?: AbortSignal
  /**
   * M12-P0：摘要 LLM 调用的 usage 上报——压缩是真金白银的 LLM 调用（分批 map-reduce 可能多批），
   * 此前直接消费流不上报，token 消耗漏账。装配层（HostSession）接到后并入会话 usage 流。
   */
  onUsage?: (inputTokens: number, outputTokens: number, cache?: { read?: number; creation?: number }) => void
}

/** 策略返回（纯计算输出：摘要文本 + 保留区起点）。 */
export interface CompactionResult {
  compacted: boolean
  /** 摘要文本（strip <analysis> 后） */
  summary?: string
  /** 保留区（tail）起始 index——boundary 的投影锚点 */
  tailStartIndex?: number
  /** 压缩前 token（审计/展示用） */
  preTokens?: number
}

/** 可插拔压缩策略接口。 */
export interface CompactionStrategy {
  readonly name: string
  /** 'free'（免模型，如工具截断）/ 'llm'（调模型摘要）。编排器按 cost 递增排序遍历 */
  readonly cost: 'free' | 'llm'
  /** 自己判断该不该跑（编排器遍历时调用） */
  shouldRun(ctx: CompactionContext): boolean
  /** 执行压缩，返回 summary/tailStartIndex（编排器据此追加 boundary） */
  run(ctx: CompactionContext): Promise<CompactionResult>
}
