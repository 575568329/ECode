import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { McpCache, configHashOf } from '../../../src/services/mcp/cache.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cachetest-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('McpCache（M-P4）', () => {
  it('set/get 命中 + 持久化（新实例读回）', async () => {
    const file = path.join(dir, 'c.json')
    const c1 = new McpCache(file)
    const cfg = { type: 'stdio' as const, command: 'node' }
    await c1.set('fs', { configHash: configHashOf(cfg), tools: [{ name: 't' }], cachedAt: 1 })
    expect(c1.get('fs', configHashOf(cfg))).toMatchObject({ tools: [{ name: 't' }] })
    const c2 = new McpCache(file)
    expect(c2.get('fs', configHashOf(cfg))).toBeDefined()
  })

  it('configHash 不匹配 → 未命中（配置变更缓存作废）', async () => {
    const c = new McpCache(path.join(dir, 'c.json'))
    await c.set('fs', { configHash: 'aaa', tools: [], cachedAt: 1 })
    expect(c.get('fs', 'bbb')).toBeUndefined()
    expect(c.get('fs', 'aaa')).toBeDefined()
  })

  it('configHashOf：字段变化 → hash 变；同配置稳定', () => {
    const a = { type: 'stdio' as const, command: 'node', args: ['x'] }
    const b = { type: 'stdio' as const, command: 'node', args: ['x'] }
    const c = { type: 'stdio' as const, command: 'node', args: ['y'] }
    expect(configHashOf(a)).toBe(configHashOf(b))
    expect(configHashOf(a)).not.toBe(configHashOf(c))
  })

  it('文件缺失/损坏 → 空缓存不崩', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json{')
    const c = new McpCache(path.join(dir, 'bad.json'))
    expect(c.get('x', 'h')).toBeUndefined()
    const c2 = new McpCache(path.join(dir, 'missing.json'))
    expect(c2.get('x', 'h')).toBeUndefined()
  })

  it('并发 set 串行不丢条目', async () => {
    const c = new McpCache(path.join(dir, 'c.json'))
    await Promise.all([
      c.set('a', { configHash: 'h', tools: [], cachedAt: 1 }),
      c.set('b', { configHash: 'h', tools: [], cachedAt: 2 }),
      c.set('c', { configHash: 'h', tools: [], cachedAt: 3 }),
    ])
    const c2 = new McpCache(path.join(dir, 'c.json'))
    expect(c2.get('a', 'h')).toBeDefined()
    expect(c2.get('b', 'h')).toBeDefined()
    expect(c2.get('c', 'h')).toBeDefined()
  })
})
