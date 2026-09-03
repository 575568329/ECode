/** 活动流 B2：ThinkingLine 全链消化（isMessageLine 投影排除 / messagesToCommitted 原序 item / restore 往返）。 */
import { describe, it, expect } from 'vitest'
import { isMessageLine, type HistoryLine, type Message } from '../../src/core/types.js'
import { buildContextMessages } from '../../src/core/context.js'
import { messagesToCommitted } from '../../src/tui/commit.js'
import { FileHistoryStore } from '../../src/services/history.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const msg = (role: 'user' | 'assistant', text: string): Message =>
  ({ role, content: [{ type: 'text', text }] }) as Message

describe('活动流 B2：ThinkingLine 消化链', () => {
  const lines: HistoryLine[] = [
    msg('user', '问'),
    { thinking: true, text: '先想结构', durMs: 4200, time: '2026-09-02T00:00:00Z' },
    msg('assistant', '答'),
  ]

  it('isMessageLine 排除 thinking 行（不进 LLM 上下文）', () => {
    expect(lines.filter(isMessageLine)).toHaveLength(2)
    expect(buildContextMessages(lines).some((m) => (m.content[0] as { text?: string }).text === '先想结构')).toBe(false)
  })

  it('messagesToCommitted：thinking 按原序消化成 item（id 前缀 th，durMs 透传）', () => {
    const items = messagesToCommitted(lines)
    const th = items.find((i) => i.kind === 'thinking')
    expect(th).toMatchObject({ kind: 'thinking', durMs: 4200, text: '先想结构' })
    // 原序：user → thinking → assistant-text
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'assistant-text'])
  })

  it('HistoryStore appendThinking → restoreFull 往返带回（restore 消息流不含）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-think-'))
    try {
      const h = new FileHistoryStore({ sessionId: 'sess-think', model: 'm', dir })
      h.append(msg('user', '问'))
      h.appendThinking({ thinking: true, text: '思考全文', durMs: 1000, time: '2026-09-02T00:00:00Z' })
      h.append(msg('assistant', '答'))
      const full = h.restoreFull('sess-think')
      expect(full).toHaveLength(3)
      expect(full[1]).toMatchObject({ thinking: true, text: '思考全文' })
      expect(h.restore('sess-think')).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe('审查器附注卡拆分（session 拼接的合成指令不冒充用户）', () => {
  const CARD = '[审查器附注（glm-5.3 对近期任务轨迹的纠偏摘要，自动生成非用户消息，仅供参考）]' + String.fromCharCode(10) + '卡内容'

  // 2026-09-03 归属根治（e268776）：合成指令标记从字符串匹配改为 Message.meta 结构化——
  // 宿主不再拼接（预注入独立消息带 meta），渲染层按 meta.kind 分流。旧「拼接形态」测例
  // 随拼接路径退役改为：用户消息 + 独立 review-card meta 消息两条输入。
  it('meta 标记：用户气泡 + 卡片消息转 review-card 系统行', () => {
    const items = messagesToCommitted([
      msg('user', '帮我改A'),
      { ...msg('user', CARD), meta: { kind: 'review-card' as const } },
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'review-card'])
    expect(items[0]).toMatchObject({ kind: 'user', text: '帮我改A' })
    expect(items[1]).toMatchObject({ kind: 'review-card' })
  })

  it('轮内插话整条卡（meta）：无用户气泡', () => {
    const items = messagesToCommitted([{ ...msg('user', CARD), meta: { kind: 'review-card' as const } }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'review-card' })
  })

  it('无卡普通消息不受影响', () => {
    const items = messagesToCommitted([msg('user', '普通输入')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', text: '普通输入' })
  })
})
