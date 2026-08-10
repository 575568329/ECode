// ============================================================
// Token 计数器 —— length/4 粗估（仿 Claude Code，零依赖）
// ============================================================
//
// 压缩阈值判断不需要精确 token 数，只需"够不够触发"的趋势。
// length/4 粗估：英文约 4 字符/token，中文实际约 1-2 字符/token，
// 所以 length/4 对中文会高估 → 倾向早压缩 → 容错方向（安全）。
//
// 参考: claude-code-main/services/tokenEstimation.ts:203-208 roughTokenCountEstimation
// ============================================================

import type { ECodeMessage, ECodeContentBlock } from './providers/types.js';

/**
 * 判断一段文本是否像 JSON（JSON / JSONL / JSONC）。
 * JSON 类内容单字符 token 多，用 length/2 估算更准确。
 * 参考: claude-code-main/services/tokenEstimation.ts:215-224 isJSONLike
 */
function isJsonLike(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
}

/**
 * 估算一段文本的 token 数。
 * - 普通文本: Math.round(len / 4)
 * - JSON/JSONL 类: Math.round(len / 2)（单字符 token 多）
 * - 空字符串: 0
 */
function estimateTextTokens(text: string, isJson: boolean): number {
  if (text.length === 0) return 0;
  return Math.round(text.length / (isJson ? 2 : 4));
}

/**
 * 估算单个 content block 的 token 数。
 */
function estimateBlockTokens(block: ECodeContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text, isJsonLike(block.text));

    case 'tool_call': {
      // tool_call: id + name + input 序列化后估算
      const parts = [block.id, block.name, JSON.stringify(block.input)];
      const combined = parts.join('');
      return estimateTextTokens(combined, true); // JSON 部分用 /2
    }

    case 'tool_result': {
      const output = block.output;
      switch (output.type) {
        case 'text':
          return estimateTextTokens(output.value, isJsonLike(output.value));
        case 'error':
          return estimateTextTokens(output.value, false);
        case 'json':
          return estimateTextTokens(JSON.stringify(output.value), true);
      }
    }

    case 'image': {
      // 图片 base64 数据估算：粗略按 base64 长度 / 3 得原始字节数，再 / 1000 token
      return Math.max(1, Math.round((block.source.data.length * 3) / 4 / 1000));
    }
  }
}

/**
 * 估算一条 ECodeMessage 的 token 数。
 */
function estimateMessageTokens(msg: ECodeMessage): number {
  if (typeof msg.content === 'string') {
    return estimateTextTokens(msg.content, isJsonLike(msg.content));
  }
  // block 数组: 累加每个 block
  return msg.content.reduce((sum, block) => sum + estimateBlockTokens(block), 0);
}

/**
 * length/4 粗估一段 ECode 消息历史的 token 数（仿 Claude Code）。
 *
 * @param model - 模型名（预留，当前不区分模型；未来可按模型选不同估算策略）
 * @param system - system prompt 文本
 * @param messages - ECode 内部格式的消息历史
 * @returns 估算 token 数（不追求精确，只求趋势正确）
 */
export function countTokens(
  model: string,
  system: string,
  messages: ECodeMessage[],
): number {
  // model 参数预留：当前所有模型统一 length/4，未来可按模型区分
  void model;

  let total = estimateTextTokens(system, isJsonLike(system));
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}
