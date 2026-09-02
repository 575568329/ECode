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
      const h = new FileHistoryStore(dir)
      h.setSessionId('sess-think', 'm')
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
