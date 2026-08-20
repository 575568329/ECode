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
