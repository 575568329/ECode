/** 图片落盘双向转换测（M10-P2b）：ImageBlock↔ImageRef、恢复降级、Alt+V 键位。 */
import {describe, expect, it, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { FileHistoryStore } from '../../src/services/history.js'
import { readFileTool } from '../../src/tools/builtin/read_file.js'
import { isBoundary, type ImageBlock, type Message } from '../../src/core/types.js'
import { InputStream } from '../../src/tui/InputStream.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

function makeImg(path: string, data = 'AAA'): ImageBlock {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data }, _w: 10, _h: 10, _path: path }
}

function png1x1(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const len = Buffer.from([0, 0, 0, 13])
  const ihdr = Buffer.from('IHDR')
  const data = Buffer.alloc(13)
  data.writeUInt32BE(1, 0)
  data.writeUInt32BE(1, 4)
  return Buffer.concat([sig, len, ihdr, data, Buffer.alloc(4)])
}

describe('history 图片双向转换', () => {
  it('append 带 _path 的 ImageBlock → 落盘 image_ref（base64 不进文件）；restoreFull → 转回 ImageBlock（重读文件）', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ecode-img-hist-'))
    mkdirSync(join(dir, 'att'))
    const imgPath = join(dir, 'att', 'p.png')
    writeFileSync(imgPath, png1x1())
    const store = new FileHistoryStore({ sessionId: 's-img', model: 'm', dir: join(dir, 'sessions') })
    const msg: Message = { role: 'user', content: [{ type: 'text', text: '看图' }, makeImg(imgPath)] }
    store.append(msg)
    // 落盘行不含 base64、含 image_ref + 路径
    const raw = readFileSync(join(dir, 'sessions', 's-img.jsonl'), 'utf8')
    expect(raw).toContain('image_ref')
    expect(raw).toContain(imgPath.replace(/\\/g, '\\\\'))
    expect(raw).not.toContain('AAA') // base64 未落盘
    // 恢复：转回 ImageBlock（重读文件得到真 base64）
    const restored = store.restoreFull('s-img')
    const img = restored[0]?.content.find((b) => b.type === 'image') as ImageBlock
    expect(img).toBeDefined()
    expect(img.source.data).toBe(png1x1().toString('base64'))
    expect(img._w).toBe(1) // 恢复时重解析尺寸
    rmSync(dir, { recursive: true, force: true })
  })
  it('文件缺失 → 降级 TextBlock 占位（不炸）', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ecode-img-hist2-'))
    mkdirSync(join(dir, 'sessions'))
    writeFileSync(
      join(dir, 'sessions', 's-gone.jsonl'),
      `${JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_ref', path: join(dir, 'nope.png'), media_type: 'image/png' }] })}\n`,
    )
    const store = new FileHistoryStore({ sessionId: 'x', model: 'm', dir: join(dir, 'sessions') })
    const restored = store.restoreFull('s-gone')
    const fallback = restored[0]?.content.find((b) => b.type === 'text' && b.text.includes('图片已失效'))
    expect(fallback).toBeDefined()
    rmSync(dir, { recursive: true, force: true })
  })
  it('无 _path 的图不转 ref（base64 兜底不丢内容）；boundary 行不受影响', async () => {
    const { mkdtempSync, readFileSync, rmSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ecode-img-hist3-'))
    mkdirSync(join(dir, 'sessions'))
    const store = new FileHistoryStore({ sessionId: 's-keep', model: 'm', dir: join(dir, 'sessions') })
    store.append({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'KEEPME' } } as ImageBlock] })
    const raw = readFileSync(join(dir, 'sessions', 's-keep.jsonl'), 'utf8')
    expect(raw).toContain('KEEPME')
    expect(isBoundary(store.restoreFull('s-keep')[0]!)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('InputStream Alt+V 键位', () => {
  it('Alt+V 触发 onPasteImage（meta+v）；返回标签则插入输入框文本（v2 内嵌形态）', async () => {
    const onPasteImage = vi.fn(async () => '[图片#1]')
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, onPasteImage }),
    )
    stdin.write('\x1bv') // ESC+v = Alt+v（meta 组合的终端编码）
    await new Promise((r) => setTimeout(r, 40))
    expect(onPasteImage).toHaveBeenCalled()
    expect(lastFrame() ?? '').toContain('[图片#1]')
  })

  it('Alt+V 返回 null（无图）→ 不插入文本', async () => {
    const onPasteImage = vi.fn(async () => null)
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, onPasteImage }),
    )
    stdin.write('\x1bv')
    await new Promise((r) => setTimeout(r, 40))
    expect(onPasteImage).toHaveBeenCalled()
    expect(lastFrame() ?? '').not.toContain('[图片#1]')
  })
})

describe('read_file 主路径的 tool_result.blocks 落盘（终审 P1-1）', () => {
  it('read_file 读图 → history 落盘为 image_ref（base64 不进会话文件）；restoreFull 经 blocks 递归转回', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ecode-rf-hist-'))
    const imgPath = join(dir, 'shot.png')
    // 最小 PNG（签名+IHDR 1x1）
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), (() => { const d = Buffer.alloc(13); d.writeUInt32BE(1, 0); d.writeUInt32BE(1, 4); return d })(), Buffer.alloc(4)])
    writeFileSync(imgPath, Buffer.concat([sig, ihdr]))
    const sessionsDir = join(dir, 'sessions')
    mkdirSync(sessionsDir)
    // 模拟 loop：read_file 返回 blocks → 构造 tool_result 消息 append
    const r = await readFileTool.execute({ path: imgPath }, { cwd: dir, signal: new AbortController().signal, model: 'glm-4.6v' })
    expect(r.blocks?.[0]).toBeDefined()
    const store = new FileHistoryStore({ sessionId: 's-rf', model: 'm', dir: sessionsDir })
    store.append({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: r.content, blocks: r.blocks }] })
    const raw = readFileSync(join(sessionsDir, 's-rf.jsonl'), 'utf8')
    expect(raw).toContain('image_ref')
    expect(raw).toContain(imgPath.replace(/\\/g, '\\\\'))
    expect(raw).not.toContain(r.blocks![0]!.source.data.slice(0, 20)) // base64 未落盘
    // 恢复：blocks 内 image_ref 递归转回 ImageBlock
    const restored = store.restoreFull('s-rf')
    const tr = restored[0]?.content[0] as { blocks?: Array<{ type: string }> }
    expect(tr?.blocks?.[0]?.type).toBe('image')
    rmSync(dir, { recursive: true, force: true })
  })
})
