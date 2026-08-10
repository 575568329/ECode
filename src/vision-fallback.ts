// vision-fallback.ts —— 图片输入降级（一次性预处理，不进迭代）
//
// 策略：只看模型是否支持 vision，不自动切模型。
//   ① 支持 → inline（直接发 image blocks）
//   ② 不支持 → strip（移除图片数据，保留文本中的文件路径 + 告知 LLM 实际情况）
//      → LLM 自己看工具列表决定：调 MCP 图片工具 / 用 bash 处理 / 告诉用户没办法
//
// 核心原则：不做代理决策（不检测 MCP、不自动切模型），把问题交给 LLM 自己判断。
// 只需告知 LLM "用户上传了图片但你的模型不支持，图片路径在文本里"，它自己会找路。

import { hasCapability } from './providers/config.js';
import type { ImageSource } from './providers/types.js';

/** 图片处理策略 */
export type ImageStrategy = 'inline' | 'strip';

/** 降级决策结果 */
export interface VisionFallbackResult {
  strategy: ImageStrategy;
  /** 用户可读的降级提示（agent.ts yield warning 给 UI 显示用） */
  warning?: string;
  /** 注入给 LLM 的提示（agent.ts 拼在 user message 后面，让 LLM 知道发生了什么） */
  llmHint?: string;
}

/**
 * 图片输入降级决策（纯函数，一次性，不进迭代）。
 *
 * @param model 当前模型
 * @param images 用户附带的图片（可能为空）
 * @returns 降级策略 + 可选提示
 */
export function resolveImageStrategy(
  model: string,
  images: ImageSource[] | undefined,
): VisionFallbackResult {
  // 无图片 → 无需降级
  if (!images || images.length === 0) {
    return { strategy: 'inline' };
  }

  // ① 模型支持 vision → 直接发 image blocks
  if (hasCapability(model, 'vision')) {
    return { strategy: 'inline' };
  }

  // ② 模型不支持 vision → strip 图片，告知 LLM 实际情况让它自己处理
  return {
    strategy: 'strip',
    warning: `当前模型 ${model} 不支持图片输入，已移除图片数据。`,
    llmHint:
      `[系统提示] 用户上传了 ${images.length} 张图片，但当前模型 ${model} 不支持图片输入，` +
      `图片数据已被移除。图片的文件路径保留在上面的用户消息文本中。` +
      `请根据你的工具列表自行决定如何处理：` +
      `如果有图片分析类工具（如 MCP 提供的 analyze_image 等），可以用文件路径调用；` +
      `如果没有合适的工具，请如实告诉用户当前模型和工具环境无法分析图片。`,
  };
}

