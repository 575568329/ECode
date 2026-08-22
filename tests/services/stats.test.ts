import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { aggregateStats, parseSessionFile, formatStats, dateKey } from '../../src/services/stats.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-stats-'))

function writeSession(id: string, lines: Array<Record<string, unknown>>): string {
  const f = path.join(tmp, `${id}.jsonl`)
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return f
}

const statsLine = (over: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  stats: true,
  ts: Date.now(),
  cwd: 'D:/work/ECode',
  model: 'glm-5.2',
  input: 100,
  output: 10,
  cacheRead: 50,
  cacheCreation: 0,
  costCny: 0.01,
  costKnown: true,
  mcpCalls: 0,
  ...over,
})

describe('dateKey', () => {
  it('本地日期 YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 7, 18, 9, 0).getTime())).toBe('2026-08-18')
    expect(dateKey(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02')
  })
})

describe('parseSessionFile', () => {
  it('只认 stats 行 + 首行 meta；mcp 取最后一条累计快照', () => {
    const f = writeSession('p1', [
      { meta: true, sessionId: 'p1', createdAt: '2026-08-18T09:00:00Z', model: 'glm-5.2', firstUser: '修个 bug' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      statsLine({ ts: new Date(2026, 7, 18, 10, 0).getTime(), input: 100, mcpCalls: 1 }),
      statsLine({ ts: new Date(2026, 7, 18, 11, 0).getTime(), input: 200, mcpCalls: 3, model: 'glm-5.2-air' }),
    ])
    const agg = parseSessionFile(f, 'p1')
    expect(agg).not.toBeNull()
    expect(agg!.totals.input).toBe(300)
    expect(agg!.mcpCalls).toBe(3)
    expect(agg!.models).toEqual(['glm-5.2', 'glm-5.2-air'])
    expect(agg!.cwd).toBe('D:/work/ECode')
    expect(agg!.firstUser).toBe('修个 bug')
    expect(Object.keys(agg!.days)).toEqual(['2026-08-18'])
  })

  it('无 stats 行返回 null（纯旧会话）', () => {
    const f = writeSession('p2', [
      { meta: true, sessionId: 'p2', createdAt: 'x', model: 'm', firstUser: 'q' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(parseSessionFile(f, 'p2')).toBeNull()
  })
})

describe('aggregateStats（含文件级 mtime 缓存）', () => {
  it('四维聚合 + 命中率 + 按天/模型/项目 + topSessions + mcp 汇总', () => {
    const dir = path.join(tmp, `agg-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    const w = (id: string, lines: Array<Record<string, unknown>>) =>
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    w('s1', [statsLine({ input: 100, output: 10, cacheRead: 100, costUsd: 0.02, mcpCalls: 2, ts: new Date(2026, 7, 17, 10, 0).getTime() })])
    w('s2', [
      statsLine({ input: 300, output: 30, cacheRead: 0, costCny: 0.03, mcpCalls: 0, ts: new Date(2026, 7, 18, 10, 0).getTime(), cwd: 'D:/other/projB', model: 'glm-4.6' }),
    ])
    w('s-nostats', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]) // 无 stats 跳过
    const agg = aggregateStats(dir, path.join(dir, 'cache.json'))
    expect(agg.sessions).toBe(2)
    expect(agg.totals.input).toBe(400)
    expect(agg.totals.cacheRead).toBe(100)
    // 审阅 P0-1：多模型会话 byModel 守恒（s2 双模型的行级归账求和 === 总计）
    const modelSum = agg.byModel.reduce((n, m) => n + m.input, 0)
    expect(modelSum).toBe(agg.totals.input)
    expect(agg.cacheHitRate).toBeCloseTo(100 / 500, 5) // cacheRead/(input+cacheRead) = 100/(400+100)
    expect(agg.mcpCalls).toBe(2)
    expect(agg.byDay.map((d) => d.date)).toEqual(['2026-08-18', '2026-08-17'])
    expect(agg.byModel[0].model).toBe('glm-4.6') // 按成本降序
    expect(agg.byProject.map((p) => p.project)).toContain('ECode')
    expect(agg.byProject.map((p) => p.project)).toContain('projB')
    expect(agg.topSessions[0].sessionId).toBe('s2')
  })

  it('缓存命中：mtime 不变跳过重读；追加行（mtime 变）重算生效', () => {
    const dir = path.join(tmp, `cache-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, 'c1.jsonl')
    fs.writeFileSync(f, JSON.stringify(statsLine({ input: 10 })) + '\n')
    const cachePath = path.join(dir, 'cache.json')
    const a1 = aggregateStats(dir, cachePath)
    expect(a1.totals.input).toBe(10)
    expect(fs.existsSync(cachePath)).toBe(true)
    const a2 = aggregateStats(dir, cachePath) // mtime 未变 → 走缓存，结果一致
    expect(a2.totals.input).toBe(10)
    // 追加一行（mtime 变化）→ 重算
    const early = new Date(Date.now() - 5000).getTime()
    fs.appendFileSync(f, JSON.stringify(statsLine({ input: 5, ts: early })) + '\n')
    const a3 = aggregateStats(dir, cachePath)
    expect(a3.totals.input).toBe(15)
  })

  it('目录不存在 → 空聚合不炸', () => {
    const agg = aggregateStats(path.join(tmp, 'not-exist-dir'), path.join(tmp, 'not-exist-cache.json'))
    expect(agg.sessions).toBe(0)
    expect(formatStats(agg)).toContain('暂无数据')
  })
})

describe('formatStats', () => {
  it('输出含关键标签（命中率/MCP/按模型/按项目/最贵会话）', () => {
    const agg = aggregateStats(path.join(tmp, 'not-exist-dir-2'), path.join(tmp, 'not-exist-cache-2.json'))
    expect(formatStats(agg)).toContain('暂无数据')
    // 有数据形态由聚合用例保证，这里锁输出结构标签
    const fake = {
      totals: { input: 1_500_000, output: 200_000, cacheRead: 900_000, cacheCreation: 100_000, costCny: 1.234 },
      mcpCalls: 7,
      sessions: 3,
      costUnknownSessions: 1,
      cacheHitRate: 0.375,
      byDay: [{ date: '2026-08-18', sessions: 2, input: 100, output: 10, cacheRead: 50, cacheCreation: 0, costCny: 0.01, mcpCalls: 0 }],
      byModel: [{ model: 'glm-5.2', input: 100, output: 10, cacheRead: 50, cacheCreation: 0, costCny: 0.01 }],
      byProject: [{ project: 'ECode', input: 100, output: 10, cacheRead: 50, cacheCreation: 0, costCny: 0.01, mcpCalls: 7 }],
      topSessions: [
        { sessionId: 's1', firstTs: 1, lastTs: Date.now(), cwd: 'D:/w/ECode', models: ['glm-5.2'], mcpCalls: 7, days: {}, byModel: {}, costUnknownLines: 0, totals: { input: 1, output: 1, cacheRead: 1, cacheCreation: 0, costCny: 0.5 }, firstUser: '修复统计' },
      ],
    }
    const out = formatStats(fake)
    expect(out).toContain('用量统计')
    expect(out).toContain('命中 37.5%')
    expect(out).toContain('MCP 7 次')
    expect(out).toContain('按模型')
    expect(out).toContain('按项目')
    expect(out).toContain('最贵会话')
    expect(out).toContain('输入 1.5M')
    expect(out).toContain('¥1.234') // 审阅 P0-2：人民币口径
    expect(out).toContain('未收录定价') // 审阅 P1-5：未知成本提示
    expect(out).toContain('最近 7 个有数据的天')
  })
})
