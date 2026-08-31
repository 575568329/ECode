import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileHistoryStore, NoopHistoryStore } from '../../src/services/history.js'
import type { Message } from '../../src/core/types.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-hist-'))

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}
function assistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('FileHistoryStore', () => {
  it('append 写首行 meta + message 行', () => {
    const dir = path.join(tmp, `a-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-a', model: 'glm-5.2', dir })
    store.append(userMsg('你好'))
    store.append(assistantMsg('你好！有什么可以帮你？'))
    const content = fs.readFileSync(path.join(dir, 'sess-a.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(3) // meta + 2 messages
    const meta = JSON.parse(lines[0])
    expect(meta.meta).toBe(true)
    expect(meta.sessionId).toBe('sess-a')
    expect(meta.firstUser).toBe('你好')
    expect(meta.model).toBe('glm-5.2')
    expect(JSON.parse(lines[1]).role).toBe('user')
    expect(JSON.parse(lines[2]).role).toBe('assistant')
  })

  it('D4 回归：listMetas 按项目过滤排除无 meta.cwd 的旧会话（lister cwd=过滤目标也不误命中）', () => {
    const dir = path.join(tmp, `d4-${Date.now()}`)
    // 复现误命中条件：normalizeProjectPath('') 经 realpathSync('') 解析到 lister 的
    // process.cwd()——把过滤目标设为 lister cwd（vitest worker 的 cwd），旧代码下无主
    // 会话会全部误命中（worker 不支持 process.chdir，故以测试进程自身 cwd 构造同条件）
    const proj = process.cwd()
    fs.mkdirSync(dir, { recursive: true })
    // 有主会话：meta.cwd=proj
    const owned = JSON.stringify({ meta: true, sessionId: 'owned', createdAt: '2026-08-30T10:00:00.000Z', model: 'm', firstUser: '有主', cwd: proj })
    fs.writeFileSync(path.join(dir, 'owned.jsonl'), owned + '\n')
    // 无主旧会话：meta 无 cwd 字段（旧版建档格式）
    const orphan = JSON.stringify({ meta: true, sessionId: 'orphan', createdAt: '2026-08-16T04:14:32.000Z', model: 'm', firstUser: '无主' })
    fs.writeFileSync(path.join(dir, 'orphan.jsonl'), orphan + '\n')
    const metas = FileHistoryStore.listMetas(dir, proj)
    expect(metas.map((m) => m.sessionId)).toEqual(['owned'])
  })

  it('forkSession 延迟播种：跳转零落盘，首条写入才播种+续写（fork 自包含）', () => {
    const dir = path.join(tmp, `fork-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'seed', model: 'm', dir })
    store.append(userMsg('原问题'))
    store.append(assistantMsg('原回答'))
    store.forkSession('fork-1', store.restoreFull('seed'), 'glm-5.2')
    // 跳转/浏览历史零文件（延迟播种——不发言不产生 fork 会话）
    expect(fs.existsSync(path.join(dir, 'fork-1.jsonl'))).toBe(false)
    // 首条写入触发播种：meta + 全量恢复行 + 新消息
    store.append(userMsg('继续问'))
    const forkLines = fs.readFileSync(path.join(dir, 'fork-1.jsonl'), 'utf8').trim().split('\n')
    expect(forkLines.length).toBe(4)
    const meta = JSON.parse(forkLines[0])
    expect(meta.sessionId).toBe('fork-1')
    expect(meta.firstUser).toBe('原问题')
    expect(meta.model).toBe('glm-5.2')
    // 旧文件只读不动；再恢复 fork 内容完整（跨重开）
    expect(fs.readFileSync(path.join(dir, 'seed.jsonl'), 'utf8').trim().split('\n').length).toBe(3)
    expect(store.restoreFull('fork-1').length).toBe(3)
  })

  it('forkSession 二跳丢弃未落盘种子（不串台）', () => {
    const dir = path.join(tmp, `fork2-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'seed', model: 'm', dir })
    store.append(userMsg('问题A'))
    store.forkSession('fork-a', store.restoreFull('seed'))
    // 跳 A 未发言 → 又跳回 seed（二次恢复）：A 的种子属于旧 id，切走即弃
    store.forkSession('fork-b', store.restoreFull('seed'))
    expect(fs.existsSync(path.join(dir, 'fork-a.jsonl'))).toBe(false)
    store.append(userMsg('继续B'))
    const b = fs.readFileSync(path.join(dir, 'fork-b.jsonl'), 'utf8')
    expect(b).toContain('问题A')
    expect(b).toContain('继续B')
    expect(b).not.toContain('继续A')
  })

  it('loadAll(cwd) 只列当前项目会话（无 cwd 老会话不显示）', () => {
    const dir = path.join(tmp, `cwd-${Date.now()}`)
    new FileHistoryStore({ sessionId: 'in-a', model: 'm', cwd: '/proj/a', dir }).append(userMsg('A项目问题'))
    new FileHistoryStore({ sessionId: 'in-b', model: 'm', cwd: '/proj/b', dir }).append(userMsg('B项目问题'))
    new FileHistoryStore({ sessionId: 'legacy', model: 'm', dir }).append(userMsg('无cwd老会话'))
    const reader = new FileHistoryStore({ sessionId: 'r', model: 'm', dir })
    const onlyA = reader.loadAll('/proj/a')
    expect(onlyA.map((m) => m.sessionId)).toEqual(['in-a'])
    // 不传 cwd 维持全局视图（web 端 collectProjectCwds 同类消费）
    expect(reader.loadAll().length).toBe(3)
  })

  it('存原始 Message（不脱敏，P0-6）', () => {
    const dir = path.join(tmp, `redact-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-r', model: 'm', dir })
    // 对话里含 API key（模拟用户贴 key）——必须原样存，脱敏会让 restore 喂不回 LLM
    store.append(userMsg('我的 key 是 sk-abc1234567890'))
    const content = fs.readFileSync(path.join(dir, 'sess-r.jsonl'), 'utf8')
    expect(content).toContain('sk-abc1234567890') // 原文，没变 [REDACTED]
  })

  it.skipIf(process.platform === 'win32')('安全审阅 P1：sessions 目录 0700（会话文件不脱敏，权限是安全边界；Windows chmod 近似 no-op 跳过）', () => {
    const dir = path.join(tmp, `perm-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-p', model: 'm', dir })
    store.append(userMsg('x'))
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('loadAll 读首行 meta（按 createdAt 倒序）', () => {
    const dir = path.join(tmp, `load-${Date.now()}`)
    const s1 = new FileHistoryStore({ sessionId: 'old', model: 'm1', dir })
    s1.append(userMsg('旧问题'))
    // 稍后创建 s2（createdAt 更新）
    const s2 = new FileHistoryStore({ sessionId: 'new', model: 'm2', dir })
    s2.append(userMsg('新问题'))
    // 用独立 store 读（loadAll 是无状态目录扫描）
    const reader = new FileHistoryStore({ sessionId: 'reader', model: 'm', dir })
    const metas = reader.loadAll()
    expect(metas).toHaveLength(2) // old + new（reader 构造只 ensureDir，没 append 无文件）
    expect(metas[0].sessionId).toBe('new') // 倒序：新在前
    expect(metas[1].sessionId).toBe('old')
    expect(metas[0].firstUser).toBe('新问题')
  })

  it('restore 还原 Message[]（跳过 meta 行）', () => {
    const dir = path.join(tmp, `restore-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-rest', model: 'm', dir })
    store.append(userMsg('恢复测试'))
    store.append(assistantMsg('回复'))
    const reader = new FileHistoryStore({ sessionId: 'reader', model: 'm', dir })
    const msgs = reader.restore('sess-rest')
    expect(msgs).toHaveLength(2) // 跳过 meta
    expect(msgs[0].role).toBe('user')
    expect(msgs[1].role).toBe('assistant')
  })

  it('setSessionId 切新文件（旧只读不破坏）', () => {
    const dir = path.join(tmp, `setid-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'old-sess', model: 'm', dir })
    store.append(userMsg('旧会话内容'))
    store.setSessionId('new-sess', 'new-model')
    store.append(userMsg('新会话内容'))
    // 旧文件保留
    const oldContent = fs.readFileSync(path.join(dir, 'old-sess.jsonl'), 'utf8')
    expect(oldContent).toContain('旧会话内容')
    expect(oldContent).not.toContain('新会话内容')
    // 新文件独立
    const newContent = fs.readFileSync(path.join(dir, 'new-sess.jsonl'), 'utf8')
    expect(newContent).toContain('新会话内容')
    expect(newContent).not.toContain('旧会话内容')
    const newMeta = JSON.parse(newContent.split('\n')[0])
    expect(newMeta.model).toBe('new-model')
  })

  it('restore 不存在的 session → 空 []', () => {
    const dir = path.join(tmp, `miss-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'x', model: 'm', dir })
    expect(store.restore('nonexistent')).toEqual([])
  })

  it('loadAll 空/不存在目录 → []', () => {
    const store = new FileHistoryStore({
      sessionId: 'x',
      model: 'm',
      dir: path.join(tmp, `empty-${Date.now()}-no-such`),
    })
    expect(store.loadAll()).toEqual([])
  })
})

describe('FileHistoryStore boundary 支持（M5 P6）', () => {
  it('appendCompactBoundary 追加 boundary 行（append-only，旧消息不删）', () => {
    const dir = path.join(tmp, `b-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-b', model: 'm', dir })
    store.append(userMsg('旧消息1'))
    store.append(assistantMsg('旧消息2'))
    store.appendCompactBoundary({ compact_boundary: true, summary: '摘要', tailStartIndex: 1, preTokens: 500 })
    store.append(userMsg('新消息'))
    const lines = fs.readFileSync(path.join(dir, 'sess-b.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(5) // meta + 2 旧 + boundary + 新
    const boundary = JSON.parse(lines[3])
    expect(boundary.compact_boundary).toBe(true)
    expect(boundary.summary).toBe('摘要')
  })

  it('M12-P0：appendUsageStats 落盘 + restoreFull/restore 跳过 stats 行（不进消息流）', () => {
    const dir = path.join(tmp, `stats-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-stats', model: 'm', dir })
    store.append(userMsg('问'))
    store.appendUsageStats({ stats: true, ts: 1700000000000, cwd: 'D:/p/x', model: 'm', input: 10, output: 2, cacheRead: 4, cacheCreation: 1, costCny: 0.001, costKnown: true, mcpCalls: 3 })
    store.append(assistantMsg('答'))
    const content = fs.readFileSync(path.join(dir, 'sess-stats.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(4) // meta + user + stats + assistant
    expect(JSON.parse(lines[2])).toMatchObject({ stats: true, cwd: 'D:/p/x', mcpCalls: 3 })
    const reader = new FileHistoryStore({ sessionId: 'reader', model: 'm', dir })
    // restore 与 restoreFull 都不含 stats 行（投影/翻译/翻转零影响）
    expect(reader.restore('sess-stats')).toHaveLength(2)
    expect(reader.restoreFull('sess-stats')).toHaveLength(2)
  })

  it('restoreFull 返回全量 HistoryLine（含 boundary，跳过 meta）', () => {
    const dir = path.join(tmp, `c-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-c', model: 'm', dir })
    store.append(userMsg('m1'))
    store.appendCompactBoundary({ compact_boundary: true, summary: 's', tailStartIndex: 0, preTokens: 0 })
    store.append(assistantMsg('m2'))
    const lines = store.restoreFull('sess-c')
    expect(lines.length).toBe(3) // m1 + boundary + m2（meta 跳过）
    expect((lines[0] as Message).role).toBe('user')
    expect((lines[1] as { compact_boundary?: true }).compact_boundary).toBe(true)
    expect((lines[2] as Message).role).toBe('assistant')
  })

  it('restore 过滤 boundary，返回纯 Message（M4 兼容）', () => {
    const dir = path.join(tmp, `d-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-d', model: 'm', dir })
    store.append(userMsg('m1'))
    store.appendCompactBoundary({ compact_boundary: true, summary: 's', tailStartIndex: 0, preTokens: 0 })
    store.append(assistantMsg('m2'))
    const msgs = store.restore('sess-d')
    expect(msgs.length).toBe(2) // m1 + m2（boundary 过滤）
    expect(msgs.every((m) => 'role' in m)).toBe(true)
  })

  it('restoreFull + buildContextMessages 联动（投影子集喂 LLM）', async () => {
    const { buildContextMessages } = await import('../../src/core/context.js')
    const dir = path.join(tmp, `e-${Date.now()}`)
    const store = new FileHistoryStore({ sessionId: 'sess-e', model: 'm', dir })
    store.append(userMsg('old1'))
    store.append(userMsg('old2'))
    store.append(userMsg('tail1'))
    store.appendCompactBoundary({ compact_boundary: true, summary: '压缩摘要', tailStartIndex: 2, preTokens: 100 })
    store.append(userMsg('new1'))
    const ctx = buildContextMessages(store.restoreFull('sess-e'))
    // 投影 = [summary] + msgs[2..] = [summary, tail1, new1]
    expect(ctx.length).toBe(3)
    expect((ctx[0].content[0] as { text: string }).text).toContain('压缩摘要')
  })
})

describe('NoopHistoryStore', () => {
  it('全部 noop（兜底/测试隔离）', () => {
    const noop = new NoopHistoryStore()
    noop.append(userMsg('x'))
    expect(noop.loadAll()).toEqual([])
    expect(noop.restore('x')).toEqual([])
    expect(() => noop.setSessionId('y')).not.toThrow()
  })
})

describe('批 2：session/archive + rename（sidecar 元数据）', () => {
  it('patchSessionMeta 写 sidecar；loadAll 合并 title/archived', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-b2-'))
    const store = new FileHistoryStore({ sessionId: '2026-08-30Tb2-x', model: 'm', cwd: 'D:/proj', dir })
    store.append(userMsg('第一条'))

    // 未打标：无 title/archived
    const before = store.loadAll('D:/proj')[0]
    expect(before?.title).toBeUndefined()
    expect(before?.archived).toBeUndefined()

    // 重命名 + 归档
    store.patchSessionMeta('2026-08-30Tb2-x', { title: '手动名字', archived: true })
    const after = store.loadAll('D:/proj')[0]
    expect(after?.title).toBe('手动名字')
    expect(after?.archived).toBe(true)

    // 恢复：archived 清除（title 保留）
    store.patchSessionMeta('2026-08-30Tb2-x', { archived: false })
    const restored = store.loadAll('D:/proj')[0]
    expect(restored?.archived).toBeUndefined()
    expect(restored?.title).toBe('手动名字')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('非法 sessionId 抛错（路径安全双保险）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-b2-'))
    const store = new FileHistoryStore({ sessionId: '2026-08-30Tb2-y', model: 'm', dir })
    expect(() => store.patchSessionMeta('../evil', { archived: true })).toThrow(/非法/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
