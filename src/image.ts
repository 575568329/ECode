// image.ts —— 多模态图片输入工具
//
// 功能：从文件路径读取图片 → base64 + mediaType（magic bytes 检测格式，不依赖扩展名）。
// 参考 Claude Code 的 detectImageFormatFromBuffer（src/utils/imageResizer.ts）。
//
// 一期不实现：剪贴板读取、图片压缩/缩放、BMP→PNG 转换。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { ImageSource } from './providers/types.js';

/** 图片文件扩展名正则（用于从用户输入文本中提取候选路径） */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;

/** 最大图片大小限制（20MB raw，base64 后约 27MB）。API 限制 5MB base64，此处先放宽读取限制，后续可加压缩。 */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Magic bytes → mediaType 映射（参考 Claude Code detectImageFormatFromBuffer） */
export function detectImageType(buffer: Buffer): string | null {
  // PNG: 89 50 4E 47
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 (GIF)
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 从文件路径读取图片 → ImageSource（base64）。
 *
 * 检测策略：先 magic bytes 判定是否为支持的图片格式，再 base64 编码。
 * 不依赖文件扩展名（扩展名可随意改，magic bytes 不会骗）。
 *
 * @returns ImageSource 成功；null 表示不是图片 / 文件不存在 / 文件过大
 */
export function readImageFromFile(filePath: string, cwd?: string): ImageSource | null {
  // 路径解析：相对路径基于 cwd（默认 process.cwd()）
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);

  // 文件存在检查
  if (!existsSync(resolvedPath)) {
    return null;
  }

  // 文件大小检查（防止读取超大文件撑爆内存）
  const stat = statSync(resolvedPath);
  if (stat.size > MAX_IMAGE_SIZE) {
    return null;
  }

  // 读取 buffer + magic bytes 检测
  const buffer = readFileSync(resolvedPath);
  const mediaType = detectImageType(buffer);
  if (!mediaType) {
    return null;
  }

  return {
    type: 'base64',
    mediaType,
    data: buffer.toString('base64'),
  };
}

/**
 * 从用户输入文本中提取图片文件路径。
 *
 * 策略：匹配文本中以图片扩展名结尾的路径片段。
 * 支持绝对路径（C:\... / /home/...）和相对路径（./screenshot.png / ../images/test.jpeg）。
 * Windows 路径反斜杠、被引号包裹的路径、被空格分隔的路径都能匹配。
 *
 * @returns 去重后的路径数组（可能为空）
 */
export function extractImagePaths(text: string): string[] {
  // 匹配策略：
  //   1) 被引号包裹的路径（单引号/双引号/反引号）：捕获引号内的内容
  //   2) 裸路径：非空白字符序列，以图片扩展名结尾
  //
  // 正则解释：
  //   ['"\`]?(...) → 可选的引号
  //   后半段确保以图片扩展名结尾
  //   路径字符：除空白外的任何字符（包括 Windows 反斜杠）
  const pattern = /['"`]?([^\s'"`]+\.(?:png|jpe?g|gif|webp))\b/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push(m[1]);
  }
  // 去重
  return [...new Set(matches)];
}