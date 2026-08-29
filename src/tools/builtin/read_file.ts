/**
 * read_file 工具（只读）：读取文本文件内容；图片/PDF 走多模态管道（M10-P0）。
 *
 * readonly:true（免确认、可并行）。文本 UTF-8；图片/PDF magic bytes 判定 → 守卫 →
 * ImageBlock/DocumentBlock 经 ToolResult.blocks 回喂（base64 不进 content 字符串主路径）。
 * 图片恒直传（2026-08-29 拆除 isVisionModel 视觉名门）：能力由端点自证，模型名名单必滞后
 * （glm-5.3-flash 有视觉却被误拦实证）；无视觉模型时端点报错经 warn 回喂用户（不进模型上下文）。
 *
 * 敏感路径门（安全审阅 P0）：本工具免确认且无路径围栏，若可直读 .env / ~/.ecode/config.json
 * （apiKey）/ id_rsa，密钥即进上下文（配合 web_fetch GET 查询串可外传）——命中敏感集合
 * 必须过用户确认（ctx.confirmSensitive）；无确认通路（argv 无头模式）fail-closed 拒绝。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Tool } from '../interface.js'
import { sensitiveGate } from '../sensitive.js'
import { buildMediaBlock } from '../../services/media.js'

/** 多模态候选扩展名（先按扩展名分流避免给每个文本文件读字节判 magic） */
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf'])

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取文件内容（UTF-8 文本；也支持图片 png/jpeg/webp/gif 与 PDF——用户让你看图/截图/读 PDF 设计时直接读路径。图片/附件原样直传模型，能否理解由模型自身能力决定，读不懂时端点会报错）。',
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
    // 敏感路径门（判定/文案集中在 tools/sensitive.ts，grep 等读类工具共用）：
    // 判定在 fs 读取之前（密钥绝不进返回值/上下文）
    const denied = await sensitiveGate(abs, ctx, 'read_file')
    if (denied !== undefined) return denied
    // M13-B1（#4）：本会话已读且 mtime 未变 → 跳过重复注入（LLM 常见"再看一眼"整段重进上下文）；
    // 文件被写后 mtime 变自然放行；bash cat 是逃生口（D6 不加 force 参数）
    if (ctx.session?.readFileGuard !== undefined && (await ctx.session.readFileGuard.check(abs))) {
      return { content: '文件自上次读取后未变化（本会话已读，见上文 tool_result）。如需强制查看可用 bash cat。' }
    }
    try {
      // 多模态分流：扩展名命中才读字节判 magic（文本主路径零额外开销）。
      // 图片恒直传（2026-08-29 拍板拆除视觉名门）：模型视觉能力由端点自证——名字名单必滞后
      // （glm-5.3-flash 有视觉却被 isVisionModel 误拦实证）；无视觉模型由端点报错自然回喂。
      const ext = path.extname(abs).toLowerCase()
      if (MEDIA_EXTS.has(ext)) {
        const buf = await fs.readFile(abs)
        const guard = buildMediaBlock(buf, ext, rel)
        if (!guard.ok) return { content: guard.reason, is_error: true }
        // 终审 P1-1：带 _path——history 落盘转 image_ref（base64 不进会话文件，主路径同粘贴路径）
        if (guard.block.type === 'image') guard.block._path = abs
        await ctx.session?.readFileGuard?.record(abs)
        return {
          content: guard.block.type === 'image' ? `已读取图片 ${rel}（内容见附图）` : `已读取 PDF ${rel}（内容见附件文档）`,
          blocks: [guard.block],
        }
      }
      const content = await fs.readFile(abs, 'utf8')
      await ctx.session?.readFileGuard?.record(abs)
      return { content }
    } catch (e) {
      return {
        content: `读取失败: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      }
    }
  },
}
