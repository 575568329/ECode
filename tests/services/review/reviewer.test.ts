/**
 * 任务纠偏审查（2026-09-02 用户拍板）：策略纯函数与格式化单测。
 * 定时兜底判定/信号判定/上下文窗口/卡清洗——接线（触发/注入）在 tests/host 覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  shouldReviewAtTurnEnd,
  longestConsecutiveErrorRun,
  shouldReviewOnSignal,
  buildReviewMessages,
  formatReviewCard,
  DEFAULT_REVIEW_INTERVAL_TURNS,
  DEFAULT_REVIEW_MIN_TURNS,
} from '../../../src/services/review/reviewer.js'
import type { Message } from '../../../src/core/types.js'

const msg = (role: 'user' | 'assistant', text: string): Message => ({ role, content: [{ type: 'text', text }] })

describe('定时兜底判定 shouldReviewAtTurnEnd', () => {
  it('默认参数：第 5/10/15…轮末触发；minTurns 前与非整除轮不触发', () => {
    // 默认 interval=5, minTurns=3
    expect(shouldReviewAtTurnEnd(1, {})).toBe(false) // 短任务闸
    expect(shouldReviewAtTurnEnd(3, {})).toBe(false) // minTurns 达到但不整除
    expect(shouldReviewAtTurnEnd(4, {})).toBe(false)
    expect(shouldReviewAtTurnEnd(5, {})).toBe(true)
    expect(shouldReviewAtTurnEnd(9, {})).toBe(false)
    expect(shouldReviewAtTurnEnd(10, {})).toBe(true)
    expect(shouldReviewAtTurnEnd(15, {})).toBe(true)
  })

  it('自定义 interval/minTurns：minTurns 是下限闸不是起点（5 的整除序不变）；interval=0 恒关', () => {
    expect(DEFAULT_REVIEW_INTERVAL_TURNS).toBe(5)
    expect(DEFAULT_REVIEW_MIN_TURNS).toBe(3)
    expect(shouldReviewAtTurnEnd(5, { minTurns: 5 })).toBe(true) // 下限放开到 5 仍第 5 触发
    expect(shouldReviewAtTurnEnd(4, { minTurns: 5 })).toBe(false)
    expect(shouldReviewAtTurnEnd(7, { intervalTurns: 7 })).toBe(true)
    expect(shouldReviewAtTurnEnd(14, { intervalTurns: 7 })).toBe(true)
    expect(shouldReviewAtTurnEnd(7, { intervalTurns: 0 })).toBe(false) // 0=禁用定时
  })
})

describe('异常信号判定', () => {
  it('最长连续失败段：跨段重置、全错、全对', () => {
    expect(longestConsecutiveErrorRun([{ isError: false }])).toBe(0)
    expect(longestConsecutiveErrorRun([{ isError: true }, { isError: false }, { isError: true }])).toBe(1)
    expect(longestConsecutiveErrorRun([{ isError: true }, { isError: true }, { isError: false }, { isError: true }, { isError: true }, { isError: true }])).toBe(3)
  })

  it('触发：连续失败 ≥2 或迭代 ≥12；阈值可调', () => {
    expect(shouldReviewOnSignal(1, 5)).toBe(false)
    expect(shouldReviewOnSignal(2, 5)).toBe(true) // 连续失败
    expect(shouldReviewOnSignal(0, 12)).toBe(true) // 长轮
    expect(shouldReviewOnSignal(0, 11)).toBe(false)
    expect(shouldReviewOnSignal(3, 1, { consecutiveErrorThreshold: 4 })).toBe(false) // 调高阈值
  })
})

describe('审查上下文 buildReviewMessages', () => {
  it('预算内原样；超预算取尾部且首条非 user 时补任务目标锚（最近的首条 user）', () => {
    const small = [msg('user', '任务目标'), msg('assistant', 'ok')]
    expect(buildReviewMessages(small, 10)).toEqual(small)
    const big: Message[] = [msg('user', '最初的任务目标'), msg('assistant', 'a'), ...Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? 'assistant' : 'user', `m${i}`))]
    const out = buildReviewMessages(big, 10)
    expect(out.length).toBe(11) // 锚 1 + 尾部 10
    expect((out[0]?.content[0] as { text: string }).text).toBe('最初的任务目标')
    expect((out.at(-1)?.content[0] as { text: string }).text).toBe('m39')
  })
})

describe('纠偏卡格式化 formatReviewCard', () => {
  it('剥控制字符（防 ESC 序列进 transcript）、首尾裁剪；空串透传', () => {
    expect(formatReviewCard('  [纠偏审查]\n- 方向：正确  ')).toBe('[纠偏审查]\n- 方向：正确')
    expect(formatReviewCard('ab\x1b[31m红\x1b[0mcd\x00')).toBe('ab[31m红[0mcd') // ESC 被剥，残文无害化
    expect(formatReviewCard('')).toBe('')
    expect(formatReviewCard('   ')).toBe('')
  })

  it('超长截断带标注', () => {
    const raw = 'x'.repeat(1500)
    const out = formatReviewCard(raw, 1200)
    expect(out.startsWith('x'.repeat(1200))).toBe(true)
    expect(out.endsWith('（审查卡超长已截断）')).toBe(true)
  })
})
