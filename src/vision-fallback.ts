// vision-fallback.ts —— 图片输入三级降级（一次性预处理，不进迭代）
//
// 为什么不是迭代/重试：
//   降级决策在 agent loop 之前做一次，结果是一个确定的策略（inline/switch/strip），
//   不进迭代循环，天然不存在无限调用。
//
// 三级降级（按优先级）：
//   1. 当前模型支持 vision → inline（直接发 image blocks，现有行为不变）
//   2. 当前模型不支持 vision，config 中有 vision 模型 → switch（自动切换模型）
//   3. 当前模型不支持 vision，无 vision 模型 → strip（移除 image blocks，保留文本中的路径；
//      LLM 可通过 MCP 工具（如 analyze_image）用文件路径分析图片）
//
// 防无限调用保证：
//   - 决策是纯函数，一次性执行，不进 agent loop 的 for 循环
//   - switch 策略：直接替换 model+provider，不回退（vision 模型失败则错误正常传播）
//   - strip 策略：移除图片后走正常文本流程，不存在重试

import { hasCapability, listAvailableModels } from './providers/config.js';
import type { ImageSource } from './providers/types.js';

/** 图片处理策略 */
export type ImageStrategy = 'inline' | 'switch' | 'strip';

/** 降级决策结果 */
export interface VisionFallbackResult {
  strategy: ImageStrategy;
  /** switch 策略：目标 vision 模型名（供 agent.ts 创建新 provider） */
  switchToModel?: string;
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

  // ② 模型不支持 vision → 查 config 有无 vision 模型可切换
  const visionModel = findVisionModel(model);
  if (visionModel) {
    return {
      strategy: 'switch',
      switchToModel: visionModel,
      warning: `当前模型 ${model} 不支持图片输入，已自动切换到 ${visionModel}。`,
    };
  }

  // ③ 无 vision 模型 → strip 图片，保留文本中的文件路径
  // LLM 看到路径文本后，可自然调用 MCP 工具（如 analyze_image）分析图片；
  // 无 MCP 工具时 LLM 会告知用户无法分析（正常降级，不崩）。
  return {
    strategy: 'strip',
    warning:
      `当前模型 ${model} 不支持图片输入。已移除图片数据，保留文本中的文件路径——` +
      `若已配置 MCP 图片分析工具（如 analyze_image），LLM 会自动调用；` +
      `若需原生图片理解，请在 config.json 的 providers 下配置带 vision 能力的模型（如 glm-4v-plus-0111）。`,
  };
}

/**
 * 在 config 中查找支持 vision 的模型（排除当前模型，避免切到自己）。
 * 优先返回首个匹配（用户在 config 中的声明顺序）。
 */
function findVisionModel(excludeModel: string): string | undefined {
  return listAvailableModels()
    .filter((m) => m.model !== excludeModel)
    .find((m) => {
      try {
        return hasCapability(m.model, 'vision');
      } catch {
        return false; // getModelConfig 抛错（模型配置不完整），跳过
      }
    })?.model;
}
