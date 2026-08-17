/**
 * 多模态媒介（M10-P0）：图片/PDF 的格式判定（magic bytes 优先）、尺寸解析、守卫。
 * 纯函数无 IO（buf 由调用方读入）——read_file 与图片粘贴（P2b）共用。
 */

import type { ImageBlock, DocumentBlock } from '../core/types.js'

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024 // 5MB（双端点最严：Anthropic 5MB / GLM 系 10MB）
export const IMAGE_MAX_DIM = 8000 // ≤8000×8000px（Anthropic 规格）
export const PDF_MAX_BYTES = 32 * 1024 * 1024 // 32MB（Anthropic 官方）
export const PDF_MAX_PAGES = 100 // 页数粗判上限（/Type /Page 计数，非 /Pages）

export type MediaKind = { kind: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' } | { kind: 'pdf' } | { kind: 'unknown' }

/** magic bytes 判定（扩展名只做初筛，字节不可伪造）。 */
export function detectMedia(buf: Buffer, ext: string): MediaKind {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', mediaType: 'image/png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'image', mediaType: 'image/jpeg' }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'image', mediaType: 'image/webp' }
  }
  if (buf.length >= 6 && (buf.toString('ascii', 0, 3) === 'GIF')) {
    return { kind: 'image', mediaType: 'image/gif' }
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') {
    return { kind: 'pdf' }
  }
  // magic 未命中：扩展名兜底（文本文件等正常路径不会走到带 media 判定的分支）
  const e = ext.toLowerCase()
  if (e === '.png') return { kind: 'image', mediaType: 'image/png' }
  if (e === '.jpg' || e === '.jpeg') return { kind: 'image', mediaType: 'image/jpeg' }
  if (e === '.webp') return { kind: 'image', mediaType: 'image/webp' }
  if (e === '.gif') return { kind: 'image', mediaType: 'image/gif' }
  if (e === '.pdf') return { kind: 'pdf' }
  return { kind: 'unknown' }
}

/** 图片尺寸解析（PNG IHDR / JPEG SOF / GIF LSD / WEBP VP8X·VP8L·VP8——各 10 行内，不引库）。 */
export function imageDimensions(buf: Buffer, mediaType: string): { w: number; h: number } | null {
  try {
    if (mediaType === 'image/png' && buf.length >= 24) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    }
    if (mediaType === 'image/gif' && buf.length >= 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
    }
    if (mediaType === 'image/jpeg') {
      // 扫 SOF0-SOF15 段（跳过 F8/COM 等无高度段）
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1
          continue
        }
        const marker = buf[i + 1]
        const isSof = (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        if (isSof) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2
          continue
        }
        i += 2 + buf.readUInt16BE(i + 2)
      }
      return null
    }
    if (mediaType === 'image/webp' && buf.length >= 30) {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') {
        const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
        const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
        return { w, h }
      }
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

/** PDF 页数粗判（字节计数 /Type /Page 且非 /Pages——容器链解析不可靠，粗计数够守卫用）。 */
export function pdfPageCount(buf: Buffer): number {
  let count = 0
  let idx = 0
  const needle = Buffer.from('/Type /Page')
  while (idx < buf.length) {
    const found = buf.indexOf(needle, idx)
    if (found === -1) break
    // '/Type /Pages' 的前 11 字节与本 needle 相同——其后第 12 字节是 's'(0x73) 则跳过
    if (buf[found + 11] !== 0x73) count += 1
    idx = found + 11
  }
  return count
}

export type MediaGuard =
  | { ok: true; block: ImageBlock | DocumentBlock }
  | { ok: false; reason: string }

/**
 * 缓冲区 → 多模态 block（含守卫）。name 供占位/提示文案用。
 * 超限返回可读 reason（调用方转 is_error）。
 */
export function buildMediaBlock(buf: Buffer, ext: string, name: string): MediaGuard {
  const media = detectMedia(buf, ext)
  if (media.kind === 'unknown') {
    return { ok: false, reason: `不支持的媒介格式：${name}（支持 png/jpeg/webp/gif 图与 pdf）` }
  }
  if (media.kind === 'pdf') {
    if (buf.length > PDF_MAX_BYTES) {
      return { ok: false, reason: `PDF 超过 ${Math.round(PDF_MAX_BYTES / 1024 / 1024)}MB 上限（${name}，${Math.round(buf.length / 1024 / 1024)}MB）——请拆分后再读` }
    }
    const pages = pdfPageCount(buf)
    if (pages > PDF_MAX_PAGES) {
      return { ok: false, reason: `PDF 约 ${pages} 页超过 ${PDF_MAX_PAGES} 页上限（${name}）——请拆分后再读` }
    }
    const block: DocumentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    return { ok: true, block }
  }
  if (buf.length > IMAGE_MAX_BYTES) {
    return { ok: false, reason: `图片超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB 上限（${name}，${Math.round(buf.length / 1024 / 1024)}MB）——请压缩后再读` }
  }
  const dim = imageDimensions(buf, media.mediaType)
  if (dim !== null && (dim.w > IMAGE_MAX_DIM || dim.h > IMAGE_MAX_DIM)) {
    return { ok: false, reason: `图片尺寸 ${dim.w}×${dim.h} 超过 ${IMAGE_MAX_DIM}px 上限（${name}）——请缩小后再读` }
  }
  const block: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: media.mediaType, data: buf.toString('base64') },
    ...(dim !== null ? { _w: dim.w, _h: dim.h } : {}),
  }
  return { ok: true, block }
}

/** 无视觉能力守卫文案（M10 唯一口径——v1.8"解析不兜底"：只说事实与出路，不点名推荐）。 */
export const NO_VISION_MESSAGE =
  '当前模型不支持图片输入。可 /model 切换到有视觉能力的模型（自选），或安装图像理解类 MCP server。'

/** 模型视觉能力判定（名称后缀启发 + 常见视觉系名单——终审 P2-10：gpt-4o/gemini 系名不含 v/vl 后缀会误拦；models.dev 视觉标记通道后置）。 */
export function isVisionModel(model: string): boolean {
  // 复审 P2-4：claude 现行命名（sonnet-4-5/opus-4-1）不含单 digit 后不匹配 \d——名单式收紧；gemini 排除 embedding
  return (
    /[-_.]v$|[-_.]\d+v$|[-_.](vl|vision)([-_.]|$)|\b4o\b|\bgpt-(4o|5|5\d)|glm-4v|qvq|internvl/i.test(model) ||
    /claude-(3|opus|sonnet|haiku|\d)/i.test(model) ||
    /gemini-(?!embedding)/i.test(model)
  )
}
