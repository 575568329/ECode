/**
 * F-46：子代理 transcript 查看器格式化格式锁——formatAgentLine 各行型的输出形态。
 * 运行期事件行（meta/tool_start/tool_result/warn）与终态 messages 行（user/assistant）
 * 两类都要人读可辨；tool_result 块带输出摘要（不再只落 'tool_result' 一词）。
 */
import { describe, it, expect, vi } from 'vitest'
import { formatAgentLine, wrapAll } from '../../src/tui/OutputViewer.js'

const W = 110

describe('formatAgentLine（子代理 transcript 格式化）', () => {
  it('meta 事件行 → 子任务头', () => {
    expect(formatAgentLine(JSON.stringify({ kind: 'meta', description: '审阅代码', type: 'general', ts: 1 }), W)).toEqual([
      '▶ 子任务 [general] 审阅代码',
    ])
  })
  it('tool_start/tool_result 事件行 → ⚙/✓ 缩进行 + 时刻（2026-09-03：阶段节奏在展开里可见）', () => {
    const ts = new Date('2026-09-03T09:08:07').getTime()
    expect(formatAgentLine(JSON.stringify({ kind: 'tool_start', name: 'bash', ts }), W)).toEqual(['  ⚙ bash 09:08:07'])
    expect(formatAgentLine(JSON.stringify({ kind: 'tool_result', name: 'bash', ts }), W)).toEqual(['  ✓ bash 完成 09:08:07'])
  })
  it('warn 事件行 → ⚠ 行 + 时刻', () => {
    const ts = new Date('2026-09-03T09:08:07').getTime()
    expect(formatAgentLine(JSON.stringify({ kind: 'warn', text: '快照跟随失败', ts }), W)).toEqual(['  ⚠ 快照跟随失败 09:08:07'])
  })
  it('user 纯文本消息 → ▶ user:', () => {
    expect(formatAgentLine(JSON.stringify({ role: 'user', content: '查 src 结构' }), W)).toEqual(['▶ user: 查 src 结构'])
  })
  it('user tool_result 块 → └ 结果摘要（非裸 tool_result 词）', () => {
    const line = JSON.stringify({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'total 4\nsrc/' }] })
    const out = formatAgentLine(line, W)
    expect(out[0]).toContain('└ 结果:')
    expect(out[0]).toContain('src/')
    expect(out[0]).not.toMatch(/^\s*tool_result\s*$/)
  })
  it('assistant text 块 → ◆ 正文（3af0e5d 与对话栅格同款）；tool_use 块 → ⚙ 工具名', () => {
    const line = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: '结论：一切正常' },
        { type: 'tool_use', id: 't9', name: 'grep', input: {} },
      ],
    })
    expect(formatAgentLine(line, W)).toEqual(['◆ 结论：一切正常', '  ⚙ grep'])
  })
  it('超长文本 preview 截断 300（物理行化由 subagentSource wrap 层负责）', () => {
    const long = '长'.repeat(300)
    const out = formatAgentLine(JSON.stringify({ role: 'user', content: long }), W)
    expect(out).toHaveLength(1)
    expect(out[0]!.startsWith('▶ user: ')).toBe(true)
    expect(out[0]!.length).toBeLessThanOrEqual(310)
  })
  it('非 JSON 行原样透出', () => {
    expect(formatAgentLine('任意非 JSON 行', W)).toEqual(['任意非 JSON 行'])
  })
})

describe('wrapAll（F-46b：物理行化在 source 侧）', () => {
  it('超长行 wrap 成 ≤ width 的物理行序列', () => {
    const lines = wrapAll('标'.repeat(400), 108)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(108)
  })
})
