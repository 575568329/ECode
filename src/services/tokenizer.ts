/**
 * 本地 token 估算（UTF-8 字节数/4，零依赖）。
 *
 * 为什么用字节而非字符数（M5 分批摘要调研修正，对齐 codex approx_token_count）：
 *   - chars/4 对中文低估约 4 倍（1 汉字 ≈ 0.6-1.0 token，JS length 记 1 → 只估出 0.25）
 *   - UTF-8 中文 3 字节/字 → bytes/4 ≈ 0.75 token/字，恰好覆盖 GLM 实测区间
 *   - ASCII 场景 bytes === chars，与旧版行为一致
 *
 * 用途（M5 §4.3）：
 *   - 压缩触发判定（每轮 provider.run 前估算，粗估够用）
 *   - usage 缺失降级（兼容端点不返回 usage 时回退估算 + UI 标「≈估算」）
 *   - 分批摘要的批预算切分（估算误差直接决定批大小，字节口径是切得准的前提）
 *
 * 不装 tokenizer：各模型 tokenizer 不同（tiktoken 只准 OpenAI），本地无法还原
 * chat template / tool schema / 图片 tile。真实计费一律用 API usage。
 */

import type { Message, ContentBlock, ToolSpec, ImageBlock, DocumentBlock } from '../core/types.js'

/** 文本 → token 估算（UTF-8 字节数/4 向上取整）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

/** 单消息 token 估算（M5 债 #3 收敛点：summarize/压缩估算共用统一口径，消除分叉）。 */
export function estimateMessageTokens(msg: Message): number {
  return Math.ceil(messageBytes(msg) / 4)
}

/** 消息序列 token 估算（estimateMessageTokens 累加）。 */
export function estimateMessagesTokens(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

/**
 * 估算 system + messages（+ 可选工具 specs）的总 token。
 * tools（M6 v3 P1-1）：MCP 工具 schema 直发给 LLM 也占上下文（20+ 工具可达 15K+ token），
 * 不计入则压缩判定低估 → 压到 summary 仍可能 400。specs JSON 序列化后按字节计。
 */
export function estimateContextTokens(system: string, messages: Message[], tools?: ToolSpec[]): number {
  let bytes = Buffer.byteLength(system, 'utf8')
  for (const msg of messages) {
    for (const block of msg.content) {
      bytes += blockBytes(block)
    }
  }
  if (tools !== undefined) {
    bytes += Buffer.byteLength(JSON.stringify(tools), 'utf8')
  }
  return Math.ceil(bytes / 4)
}

/** 单个 content block 的字节数（各形态展开成文本后计长）。 */
function blockBytes(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return Buffer.byteLength(block.text, 'utf8')
    case 'tool_use':
      return Buffer.byteLength(block.name, 'utf8') + safeStringifyBytes(block.input)
    case 'tool_result':
      return Buffer.byteLength(block.content, 'utf8') + (block.blocks?.reduce((n, b) => n + mediaBlockTokens(b) * 4, 0) ?? 0)
    // M10-P0：图片/PDF 进上下文估算——图片 (w×h)/750 换算 token 再折字节（×4 回 bytes/4 轨道）；
    // PDF 按 base64 体量近似（无页元信息，粗估方向偏大=安全侧）；尺寸缺失的图片按 1568² 中档估
    case 'image':
    case 'document':
      return mediaBlockTokens(block) * 4
  }
}

/** 多模态块的 token 估算（图片 Anthropic 公式 (w×h)/750；PDF 按体量粗估）。 */
function mediaBlockTokens(b: ImageBlock | DocumentBlock): number {
  if (b.type === 'document') return Math.ceil((b.source.data.length * 0.75) / 3000) * 1000
  const w = b._w ?? 1568
  const h = b._h ?? 1568
  return Math.ceil((w * h) / 750)
}

/** 单消息字节数（blockBytes 累加；estimateMessageTokens/estimateContextTokens 共用）。 */
function messageBytes(msg: Message): number {
  let bytes = 0
  for (const block of msg.content) bytes += blockBytes(block)
  return bytes
}

/** 防御性 JSON 序列化计长（工具入参理论上可序列化，但仍兜底）。 */
function safeStringifyBytes(input: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(input ?? ''), 'utf8')
  } catch {
    return Buffer.byteLength(String(input), 'utf8')
  }
}
