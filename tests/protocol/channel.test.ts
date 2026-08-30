/** W-9（批 4）channel 重放缓冲单测：游标重放/gap 判定/环形上限 */
import { describe, expect, it } from 'vitest'
import { InMemoryChannel } from '../../src/protocol/channel.js'
import type { PublishableEvent } from '../../src/protocol/types.js'

function delta(text: string): PublishableEvent {
  return { type: 'delta', turnId: 't1', text } as unknown as PublishableEvent
}

describe('InMemoryChannel.replaySince（W-9 断线游标续传）', () => {
  it('重放 seq > since 的缓冲帧，coveredFrom=最老缓冲帧 seq', () => {
    const ch = new InMemoryChannel()
    for (const t of ['a', 'b', 'c']) ch.publish(delta(t))
    const { events, coveredFrom } = ch.replaySince(1)
    expect(events.map((e) => e.seq)).toEqual([2, 3])
    expect(coveredFrom).toBe(1)
  })

  it('since 落在缓冲覆盖范围内（coveredFrom <= since+1）', () => {
    const ch = new InMemoryChannel()
    for (let i = 1; i <= 10; i++) ch.publish(delta(String(i)))
    const { coveredFrom } = ch.replaySince(5)
    expect(coveredFrom <= 6).toBe(true)
  })

  it('缓冲滚动覆盖 since → coveredFrom 前移（环形上限 500）', () => {
    const ch = new InMemoryChannel()
    for (let i = 1; i <= 600; i++) ch.publish(delta(String(i)))
    const { events, coveredFrom } = ch.replaySince(5)
    expect(coveredFrom).toBe(101)
    expect(events.length).toBe(500)
    expect(events[0]?.seq).toBe(101)
  })

  it('空缓冲（无发布）→ coveredFrom=lastSeq=0', () => {
    const ch = new InMemoryChannel()
    expect(ch.replaySince(0)).toEqual({ events: [], coveredFrom: 0 })
  })
})
