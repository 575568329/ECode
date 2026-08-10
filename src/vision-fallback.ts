// vision-fallback.ts —— 图片输入降级（一次性预处理，不进迭代）
//
// 策略简化（YAGNI）：不自动切模型，只看模型是否支持 vision。
//   ① 支持 → inline（直接发 image blocks）
//   ② 不支持 → strip（移除图片数据，保留文本中的文件路径）
//      → LLM 可通过 MCP 工具（如 analyze_image）用文件路径分析图片
//      → 无 MCP 工具时 LLM 会告知用户无法分析（正常降级，不崩）
//
// 为什么不自动切模型：
//   - 用户选的模型是有意图的，自动切走会丢上下文/工具能力/费用预期
//   - 不同模型的 system prompt / tools 能力不同，切换后行为不可控
//   - 用户需要时可以自己 /model 切换

import { hasCapability } from './providers/config.js';
import type { ImageSource } from './providers/types.js';

/** 图片处理策略 */
export type ImageStrategy = 'inline' | 'strip';

/** 降级决策结果 */
export interface VisionFallbackResult {
  strategy: ImageStrategy;
  /** 用户可读的降级提示（agent.ts yield warning 用） */
  warning?: string;
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
  // 无图片 → 无需降级（inline 是 no-op）
  if (!images || images.length === 0) {
    return { strategy: 'inline' };
  }

  // ① 模型支持 vision → 直接发 image blocks
  if (hasCapability(model, 'vision')) {
    return { strategy: 'inline' };
  }

  // ② 模型不支持 vision → strip 图片，保留文本中的文件路径
  // LLM 看到路径文本后，可自然调用 MCP 工具（如 analyze_image）分析图片；
  // 无 MCP 工具时 LLM 会告知用户无法分析（正常降级，不崩）。
  return {
    strategy: 'strip',
    warning:
      `当前模型 ${model} 不支持图片输入。已移除图片数据，保留文本中的文件路径——` +
      `若已配置 MCP 图片分析工具，LLM 会自动调用；` +
      `若需原生图片理解，请在 config.json 的 providers 下配置带 vision 能力的模型（如 glm-4v-plus-0111）。`,
  };
}
