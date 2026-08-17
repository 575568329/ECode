/**
 * read_file 工具（只读）：读取文本文件内容；图片/PDF 走多模态管道（M10-P0）。
 *
 * readonly:true（免确认、可并行）。文本 UTF-8；图片/PDF magic bytes 判定 → 守卫 →
 * ImageBlock/DocumentBlock 经 ToolResult.blocks 回喂（base64 不进 content 字符串主路径）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Tool } from '../interface.js'
import { buildMediaBlock, detectMedia, isVisionModel, NO_VISION_MESSAGE } from '../../services/media.js'

/** 多模态候选扩展名（先按扩展名分流避免给每个文本文件读字节判 magic） */
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf'])

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取文件内容（UTF-8 文本；也支持图片 png/jpeg/webp/gif 与 PDF——用户让你看图/截图/读 PDF 设计时直接读路径，需要视觉能力的模型才能看懂图片）。',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对 cwd 或绝对）' },
    },
    required: ['path'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { path: rel } = args as { path: string }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel)
    try {
      // 多模态分流：扩展名命中才读字节判 magic（文本主路径零额外开销）
      const ext = path.extname(abs).toLowerCase()
      if (MEDIA_EXTS.has(ext)) {
        const buf = await fs.readFile(abs)
        const media = detectMedia(buf, ext)
        if (media.kind === 'image' && !isVisionModel(ctx.model ?? '')) {
          return { content: NO_VISION_MESSAGE, is_error: true }
        }
        const guard = buildMediaBlock(buf, ext, rel)
        if (!guard.ok) return { content: guard.reason, is_error: true }
        // 终审 P1-1：带 _path——history 落盘转 image_ref（base64 不进会话文件，主路径同粘贴路径）
        if (guard.block.type === 'image') guard.block._path = abs
        return {
          content: guard.block.type === 'image' ? `已读取图片 ${rel}（内容见附图）` : `已读取 PDF ${rel}（内容见附件文档）`,
          blocks: [guard.block],
        }
      }
      const content = await fs.readFile(abs, 'utf8')
      return { content }
    } catch (e) {
      return {
        content: `读取失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
