import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LogStore } from '../../src/services/logstore.js'

const tmp = join(tmpdir(), `ecode-logstore-${Date.now()}`)
let counter = 0

/** recordWritten=true（测试断言 written；生产 false） */
function newStore(maxBuffer = 3, flushMs = 100): LogStore {
  counter += 1
  const path = join(tmp, `${counter}-${Math.random().toString(36).slice(2)}.jsonl`)
  return new LogStore(path, 'sess-test', maxBuffer, flushMs, true)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LogStore', () => {
  it('emit 未达阈值不 flush', () => {
    const s = newStore()
    s.emit('info', 'loop', 'iter_start', { iter: 1 }, 1)
    expect(s.written).toHaveLength(0)
    s.close()
  })

  it('达 maxBuffer 自动 flush', () => {
    const s = newStore(3)
    s.emit('info', 'loop', 'a')
    s.emit('info', 'loop', 'b')
    s.emit('info', 'loop', 'c')
    expect(s.written).toHaveLength(3)
    expect(s.written[0]).toContain('"event":"a"')
    s.close()
  })

  it('error 立即 flush', () => {
    const s = newStore()
    s.emit('info', 'loop', 'a')
    s.emit('error', 'loop', 'boom', { msg: 'x' })
    expect(s.written).toHaveLength(2)
    s.close()
  })

  it('close 同步 flush 剩余 buffer', () => {
    const s = newStore()
    s.emit('info', 'loop', 'a')
    s.emit('info', 'loop', 'b')
    expect(s.written).toHaveLength(0)
    s.close()
    expect(s.written).toHaveLength(2)
  })

  it('payload 脱敏（apiKey 不落日志）', () => {
    const s = newStore()
    s.emit('info', 'config', 'load', { apiKey: 'sk-secret123456789012345', model: 'glm' })
    s.flush()
    const line = s.written[0]
    expect(line).toContain('[REDACTED]')
    expect(line).not.toContain('sk-secret')
    expect(line).toContain('glm')
    s.close()
  })

  it('flushMs 定时 flush', () => {
    vi.useFakeTimers()
    const s = newStore(100, 100)
    s.emit('info', 'loop', 'a')
    expect(s.written).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(s.written).toHaveLength(1)
    s.close()
  })

  it('JSONL 结构（ts/level/category/event/sessionId）', () => {
    const s = newStore()
    s.emit('info', 'loop', 'test', { x: 1 }, 2)
    s.flush()
    const entry = JSON.parse(s.written[0])
    expect(entry).toMatchObject({
      level: 'info',
      category: 'loop',
      event: 'test',
      sessionId: 'sess-test',
      iterNum: 2,
    })
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.payload).toEqual({ x: 1 })
    s.close()
  })

  it('close 后 emit 不再写入', () => {
    const s = newStore()
    s.close()
    s.emit('info', 'loop', 'after-close')
    expect(s.written).toHaveLength(0)
  })
})


describe('M11：agentId 轨迹隔离通道', () => {
  it('emit 带尾参 agentId → 落盘条目含 agentId；不带的条目无该键', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-agentid-'))
    const store = new LogStore(join(dir, 'l.jsonl'), 'sess-agentid', 100, 10, true)
    store.emit('info', 'loop', 'agent_event', { x: 1 }, 2, 'a-x7q2')
    store.emit('info', 'loop', 'main_event', {})
    await new Promise(r => setTimeout(r, 50))
    const agentLine = store.written.find((l) => l.includes('agent_event'))
    const mainLine = store.written.find((l) => l.includes('main_event'))
    expect(agentLine).toContain('"agentId":"a-x7q2"')
    expect(mainLine).not.toContain('agentId')
  })
})
