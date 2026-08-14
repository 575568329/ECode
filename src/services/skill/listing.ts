/**
 * Skill 清单渲染（M6 S-P2 / S7）：Level 0 元数据 → <available_skills> XML 块。
 *
 * token 预算防爆炸（M6-D5）：skill 多了清单会吃 system prompt——
 *   1. 单条 description（+when_to_use 拼接）硬截断 MAX_LISTING_DESC_CHARS
 *   2. 总长超预算 → 均匀砍每条到剩余预算均分；极端时降级 names-only
 *   3. 无 skill → 空串（零开销）
 * 变化签名（S7.2）：name+description 序列指纹，增量推送（后置）的对比依据。
 *
 * 估算口径统一走 tokenizer（M5 债 #3 收敛，不再自写 CHARS_PER_TOKEN）。
 */

import type { SkillInfo } from '../skill.js'

/** 清单占上下文窗的比例（1%，业界共识档）。 */
export const BUDGET_CONTEXT_PERCENT = 0.01
/** 预算下限（窗口太小时也保证能列几个 skill）。 */
export const BUDGET_MIN_CHARS = 2000
/** 单条 description（desc + whenToUse 拼接后）硬截断。 */
export const MAX_LISTING_DESC_CHARS = 250

/** 预算计算：ctxWindow × 1%，下限 2000 字符（buildSystemPrompt 传入）。 */
export function listingBudget(ctxWindow: number): number {
  return Math.max(BUDGET_MIN_CHARS, Math.floor(ctxWindow * BUDGET_CONTEXT_PERCENT))
}

/** 单条清单文本（desc + whenToUse 拼接后截断）。 */
export function skillDesc(s: SkillInfo): string {
  const raw = s.whenToUse !== undefined && s.whenToUse !== '' ? `${s.description}（用于：${s.whenToUse}）` : s.description
  return raw.length > MAX_LISTING_DESC_CHARS ? raw.slice(0, MAX_LISTING_DESC_CHARS - 1) + '…' : raw
}

/**
 * 渲染 skill 清单（system prompt 尾部追加段）。
 * @param skills 已过滤的 LLM 面 skill（listForPrompt 结果）
 * @param charBudget 字符预算（listingBudget 产物）
 */
export function renderSkillListing(skills: SkillInfo[], charBudget: number): string {
  if (skills.length === 0) return ''
  const entries = skills.map((s) => ({ name: s.name, desc: skillDesc(s) }))
  // XML 包裹的固定开销
  const WRAP_OPEN = '<available_skills>'
  const WRAP_CLOSE = '</available_skills>'
  const HEADER = '可用的 Skill（任务匹配某项描述时，用 Skill 工具加载其完整指令）：'
  const fixed = WRAP_OPEN.length + WRAP_CLOSE.length + HEADER.length + entries.length * 4
  const available = charBudget - fixed
  if (available <= 0) return renderNamesOnly(entries, WRAP_OPEN, WRAP_CLOSE, HEADER)
  const totalDesc = entries.reduce((n, e) => n + e.desc.length, 0)
  if (totalDesc <= available) {
    return [WRAP_OPEN, HEADER, ...entries.map((e) => `  <skill><name>${e.name}</name><description>${e.desc}</description></skill>`), WRAP_CLOSE].join('\n')
  }
  // 超预算：均匀砍每条到剩余预算均分（保留头部触发词）
  const per = Math.floor(available / entries.length)
  if (per < 20) return renderNamesOnly(entries, WRAP_OPEN, WRAP_CLOSE, HEADER)
  const lines = entries.map((e) => {
    const desc = e.desc.length > per ? e.desc.slice(0, per - 1) + '…' : e.desc
    return `  <skill><name>${e.name}</name><description>${desc}</description></skill>`
  })
  return [WRAP_OPEN, HEADER, ...lines, WRAP_CLOSE].join('\n')
}

function renderNamesOnly(
  entries: { name: string }[],
  open: string,
  close: string,
  header: string,
): string {
  // 极端降级：只列名字（触发仍可靠——LLM 可先调 Skill 拿 description 不全的项再看 body）
  return [open, header + '（预算不足，仅列名）', ...entries.map((e) => `  <skill><name>${e.name}</name></skill>`), close].join('\n')
}

/** 变化签名（S7.2 增量推送的对比依据；name+description 序列指纹）。 */
export function listingSignature(skills: SkillInfo[]): string {
  return skills.map((s) => `${s.name}:${skillDesc(s)}`).join('|')
}
