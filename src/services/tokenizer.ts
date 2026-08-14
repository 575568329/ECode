/**
 * 本地 token 估算（chars/4，零依赖）。
 *
 * 用途（M5 §4.3）：
 *   - 压缩触发判定（每轮 provider.run 前估算，粗估够用）
 *   - usage 缺失降级（兼容端点不返回 usage 时回退估算 + UI 标「≈估算」）
 *   - 切 model / 压缩后旧 usage 失效时的临时基准
 *
 * 不装 tokenizer：各模型 tokenizer 不同（tiktoken 只准 OpenAI），本地无法还原
 * chat template / tool schema / 图片 tile，偏低 10-30%。真实计费一律用 API usage。
 */

import type { Message, ContentBlock } from '../core/types.js'

/** 字符 → token 估算（chars/4 向上取整）。 */
export function charsToTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** 估算 system + messages 的总 token（各 content block 累加 chars/4）。 */
export function estimateContextTokens(system: string, messages: Message[]): number {
  let chars = system.length
  for (const msg of messages) {
    for (const block of msg.content) {
      chars += blockChars(block)
    }
  }
  return Math.ceil(chars / 4)
}

/** 单个 content block 的字符数（各形态展开成文本后计长）。 */
function blockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length
    case 'tool_use':
      return block.name.length + safeStringifyLen(block.input)
    case 'tool_result':
      return block.content.length
  }
}

/** 防御性 JSON 序列化计长（工具入参理论上可序列化，但仍兜底）。 */
function safeStringifyLen(input: unknown): number {
  try {
    return JSON.stringify(input ?? '').length
  } catch {
    return String(input).length
  }
}
