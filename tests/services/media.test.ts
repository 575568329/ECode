/** 多模态媒介测（M10-P0）：格式判定/尺寸/守卫/页数 + read_file 多模态集成（纯函数 + tmpdir 真文件）。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectMedia,
  imageDimensions,
  pdfPageCount,
  buildMediaBlock,
} from '../../src/services/media.js'
import { readFileTool } from '../../src/tools/builtin/read_file.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecode-media-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 最小合法 PNG（8 字节签名 + IHDR 13 字节数据：1×1） */
function minPng(w = 1, h = 1): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const len = Buffer.from([0, 0, 0, 13])
  const ihdr = Buffer.from('IHDR')
  const data = Buffer.alloc(13)
  data.writeUInt32BE(w, 0)
  data.writeUInt32BE(h, 4)
  data[8] = 8 // bit depth
  data[9] = 2 // color type
  return Buffer.concat([sig, len, ihdr, data, Buffer.alloc(4)]) // crc 空占位（判定只看前 24 字节）
}

const GIF1x1 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00])

describe('detectMedia（magic bytes 优先）', () => {
  it('PNG/JPEG/GIF/WEBP/PDF 按 magic 判定（扩展名错也不认）', () => {
    expect(detectMedia(minPng(), '.jpg')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(detectMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), '.png')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(detectMedia(GIF1x1, '.png')).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(detectMedia(Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(20)]), '.png')).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(detectMedia(Buffer.from('%PDF-1.7\n'), '.png')).toEqual({ kind: 'pdf' })
  })
  it('magic 未命中按扩展名兜底；双未命中 unknown', () => {
    expect(detectMedia(Buffer.from('plain'), '.png')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(detectMedia(Buffer.from('plain'), '.txt')).toEqual({ kind: 'unknown' })
  })
})

describe('imageDimensions', () => {
  it('PNG IHDR / GIF LSD 读宽高', () => {
    expect(imageDimensions(minPng(640, 480), 'image/png')).toEqual({ w: 640, h: 480 })
    expect(imageDimensions(GIF1x1, 'image/gif')).toEqual({ w: 1, h: 1 })
  })
})

describe('pdfPageCount（/Type /Page 非 /Pages 粗计数）', () => {
  it('三页 PDF 计 3', () => {
    const buf = Buffer.from('%PDF-1.4\n/Type /Page\ncontent\n/Type /Pages\nkids\n/Type /Page\nx\n/Type /Page\n')
    expect(pdfPageCount(buf)).toBe(3)
  })
})

describe('buildMediaBlock（守卫）', () => {
  it('合法 PNG → ImageBlock（含尺寸元信息 + base64）', () => {
    const r = buildMediaBlock(minPng(100, 200), '.png', 'a.png')
    expect(r.ok).toBe(true)
    if (r.ok && r.block.type === 'image') {
      expect(r.block.source.media_type).toBe('image/png')
      expect(r.block.source.data).toBe(minPng(100, 200).toString('base64'))
      expect(r.block._w).toBe(100)
      expect(r.block._h).toBe(200)
    }
  })
  it('图片超 5MB / 尺寸超 8000px 拒绝（可读文案）', () => {
    const big = Buffer.concat([minPng(), Buffer.alloc(5 * 1024 * 1024 + 100)])
    const r1 = buildMediaBlock(big, '.png', 'big.png')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain('5MB')
    const wide = buildMediaBlock(minPng(9000, 100), '.png', 'wide.png')
    expect(wide.ok).toBe(false)
    if (!wide.ok) expect(wide.reason).toContain('8000')
  })
  it('PDF 超 32MB / 超 100 页拒绝；合法 PDF → DocumentBlock', () => {
    const bigPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32 * 1024 * 1024 + 100)])
    const r1 = buildMediaBlock(bigPdf, '.pdf', 'big.pdf')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain('32MB')
    const pages = Array.from({ length: 101 }, () => '/Type /Page\n').join('')
    const r2 = buildMediaBlock(Buffer.from(`%PDF-1.4\n${pages}`), '.pdf', 'many.pdf')
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain('100')
    const ok = buildMediaBlock(Buffer.from('%PDF-1.4\n/Type /Page\n'), '.pdf', 'ok.pdf')
    expect(ok.ok).toBe(true)
    if (ok.ok && ok.block.type === 'document') expect(ok.block.source.media_type).toBe('application/pdf')
  })
})

describe('read_file 多模态集成', () => {
  it('读 PNG 恒直传（2026-08-29 拆视觉名门）——vision/非 vision 模型名都返回 ImageBlock，由端点自证能力', async () => {
    const p = join(dir, 'a.png')
    writeFileSync(p, minPng(10, 10))
    const ctxV = { cwd: dir, signal: new AbortController().signal, model: 'glm-4.6v' }
    const r1 = await readFileTool.execute({ path: 'a.png' }, ctxV)
    expect(r1.is_error).toBeFalsy()
    expect(r1.blocks?.[0]?.type).toBe('image')
    const ctxT = { cwd: dir, signal: new AbortController().signal, model: 'glm-4.6' }
    const r2 = await readFileTool.execute({ path: 'a.png' }, ctxT)
    expect(r2.is_error).toBeFalsy()
    expect(r2.blocks?.[0]?.type).toBe('image')
  })
  it('读 PDF → document block；读 txt 不走多模态（无 blocks）', async () => {
    const pdf = join(dir, 'doc.pdf')
    writeFileSync(pdf, '%PDF-1.4\n/Type /Page\n')
    const r = await readFileTool.execute({ path: 'doc.pdf' }, { cwd: dir, signal: new AbortController().signal, model: 'glm-4.6v' })
    expect(r.blocks?.[0]?.type).toBe('document')
    const txt = join(dir, 't.txt')
    writeFileSync(txt, 'hello')
    const r2 = await readFileTool.execute({ path: 't.txt' }, { cwd: dir, signal: new AbortController().signal })
    expect(r2.content).toBe('hello')
    expect(r2.blocks).toBeUndefined()
  })
})
