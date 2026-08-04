// ============================================================
// ContextManager —— 上下文管理（token 计数 + 摘要压缩）
// ============================================================
//
// M3 核心。两个关键约束（用户明确）：
// 1. "一个提问和回答是一个最小单元" → 压缩边界必须落在完整的工具往返之间，
//    绝不劈开一个 tool_call + tool_result 配对（否则 Anthropic API 400）。
// 2. "压缩后数据结构不变" → 输出仍是 ECodeMessage[]，agent loop 无感知。
//
// 本文件先实现纯函数算法（可单测），maybeCompress 门面后补。
// ============================================================

import type { ECodeContentBlock, ECodeMessage, ECodeToolResultOutput } from './providers/types.js';
import { countTokens } from './token-counter.js';
import { getContextWindow } from './providers/config.js';

// ---------------- 类型定义 ----------------

/** 一对 tool id（call 侧 + result 侧） */
export interface ToolIdPair {
  calls: string[];
  results: string[];
}

/** 一个"工具往返组"——压缩的最小不可分割单位 */
export interface ToolRound {
  /** 该组包含的消息（1~N 条，可能含 text + tool_call + tool_result） */
  messages: ECodeMessage[];
  /** 是否含工具配对（true = tool_call+tool_result 往返；false = 纯文本消息） */
  hasToolPair: boolean;
}

// ---------------- 配对完整性 ----------------

/**
 * 遍历 messages，收集所有 tool_call.id 和 tool_result.tool_use_id。
 * 用于配对完整性校验（防孤儿 → API 400）。
 */
export function collectToolIds(messages: ECodeMessage[]): ToolIdPair {
  const calls: string[] = [];
  const results: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_call') {
        calls.push(block.id);
      } else if (block.type === 'tool_result') {
        results.push(block.tool_use_id);
      }
    }
  }
  return { calls, results };
}

/**
 * 配对完整性校验：tool_call.id 集合 必须 == tool_result.tool_use_id 集合。
 * 不等（有孤儿）→ 返回 false。
 *
 * 这是压缩返回前的最后防线：宁可让 agent 崩（可重试），也不发配对坏的数据给 API（必 400）。
 */
export function verifyPairing(pair: ToolIdPair): boolean {
  const callSet = new Set(pair.calls);
  const resultSet = new Set(pair.results);
  if (callSet.size !== resultSet.size) return false;
  for (const id of callSet) {
    if (!resultSet.has(id)) return false;
  }
  return true;
}

/** 便捷封装：直接对 messages 做配对校验 */
export function verifyMessagesPairing(messages: ECodeMessage[]): boolean {
  return verifyPairing(collectToolIds(messages));
}

// ---------------- 成对分组 ----------------

/**
 * 把 messages 按"工具往返"分组。
 *
 * 分组规则（实现"最小单元是工具往返"约束）：
 * - 遇到 assistant 含 tool_call 的消息 → 开启一个往返组
 * - 后续的 tool_result 消息归入当前往返组
 * - 纯 text 消息（无工具）→ 各自独立一组
 *
 * 一个 assistant 消息可能含多个 tool_call（并行工具），它们和对应的 tool_results
 * 全部归到同一往返组 —— 绝不拆散。
 */
export function groupToolRounds(messages: ECodeMessage[]): ToolRound[] {
  const rounds: ToolRound[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    const blocks = typeof msg.content === 'string' ? [] : msg.content;
    const hasToolCall = blocks.some((b) => b.type === 'tool_call');

    if (msg.role === 'assistant' && hasToolCall) {
      // 开启一个工具往返组：收集这条 assistant（含 tool_call）+ 后续所有 tool_result
      const group: ECodeMessage[] = [msg];
      const callIds = new Set(
        blocks.filter((b) => b.type === 'tool_call').map((b) => (b as { id: string }).id),
      );

      // 向前吃掉所有 tool_result 消息（直到收集齐所有 callId 的 result，或遇到非 tool_result）
      i++;
      while (i < messages.length) {
        const next = messages[i];
        const nextBlocks = typeof next.content === 'string' ? [] : next.content;
        const nextResults = nextBlocks.filter((b) => b.type === 'tool_result');
        if (next.role === 'user' && nextResults.length > 0) {
          group.push(next);
          // 检查是否收集齐了所有 callId
          for (const r of nextResults) {
            callIds.delete((r as { tool_use_id: string }).tool_use_id);
          }
          i++;
          // 所有 callId 都有 result 了 → 往返组完整
          if (callIds.size === 0) break;
        } else {
          break; // 遇到非 tool_result → 往返组结束
        }
      }

      rounds.push({ messages: group, hasToolPair: true });
    } else {
      // 纯文本消息（user/assistant 无工具）→ 独立一组
      rounds.push({ messages: [msg], hasToolPair: false });
      i++;
    }
  }

  return rounds;
}

// ---------------- 切分（按往返边界）----------------

export interface SplitOptions {
  /** 保留最近 N 个往返组（默认 6） */
  keepRounds?: number;
}

/**
 * 把 messages 切成 early（待压缩）+ recent（保留）两部分。
 *
 * 关键：切分点必须落在完整的往返组之间 —— `adjustToCompleteToolRound`。
 * 这实现用户约束"一个提问和回答是最小单元"：绝不把一个往返组劈开。
 *
 * recent 取最后 keepRounds 个往返组；其余归 early。
 * early + recent 拼接 == 原 messages 全集（不丢消息）。
 */
export function splitForCompression(
  messages: ECodeMessage[],
  opts: SplitOptions = {},
): { early: ECodeMessage[]; recent: ECodeMessage[] } {
  const keepRounds = opts.keepRounds ?? 6;
  const rounds = groupToolRounds(messages);

  // 往返组数 ≤ keepRounds → 全部保留，无待压缩
  if (rounds.length <= keepRounds) {
    return { early: [], recent: messages };
  }

  // 从末尾取 keepRounds 个往返组作为 recent
  const splitIndex = rounds.length - keepRounds;
  const earlyRounds = rounds.slice(0, splitIndex);
  const recentRounds = rounds.slice(splitIndex);

  const early = earlyRounds.flatMap((r) => r.messages);
  const recent = recentRounds.flatMap((r) => r.messages);

  return { early, recent };
}

// ---------------- L2: tool-result 内容清空(零 LLM 成本)----------------

/**
 * 旧 tool_result 被清空内容后的占位符。
 * 保留 tool_use_id → 配对不断裂,所以这一步完全安全(不破坏 tool 链)。
 *
 * 出处:Claude Code `TIME_BASED_MC_CLEARED_MESSAGE`(microCompact.ts:36)、
 * CCode `ToolResultTrimStrategy.TOOL_RESULT_PLACEHOLDER`(context-manager.ts:204)。
 */
export const TRIMMED_TOOL_RESULT_PLACEHOLDER =
  '[已清除以节省上下文：旧工具输出。需要时请重新调用工具]';

/**
 * 把旧 tool_result 的【内容】换成占位符,但保留 tool_use_id → 配对不断裂。
 * 零 LLM 成本,完全安全。这是处理"recent 窗口本身超限"的唯一手段——
 * LLM 摘要压不动已经在保留区的 tool_result,但本函数能直接清空它的内容。
 *
 * @param keepRecent 保留最近 N 个 tool_result 的原文(默认 3),其余清空内容
 * @returns 新数组(原数组不变);若无需清空则原样返回同一引用
 */
export function trimToolResultContents(
  messages: ECodeMessage[],
  keepRecent = 3,
): ECodeMessage[] {
  // 1. 收集所有 tool_result 的 tool_use_id(按出现顺序)
  const toolUseIds: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        toolUseIds.push(block.tool_use_id);
      }
    }
  }

  // tool_result 数 ≤ keepRecent → 无需清空,原样返回
  if (toolUseIds.length <= keepRecent) return messages;

  // 2. 保留最后 keepRecent 个,其余的 tool_use_id 进清空集合
  const trimSet = new Set(toolUseIds.slice(0, toolUseIds.length - keepRecent));
  if (trimSet.size === 0) return messages;

  // 3. 深拷贝涉及到的 messages,把 tool_result.output 统一换成 text 占位符
  // (原 output 可能是 text/error/json,清空后语义统一为 text)
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    let touched = false;
    const newContent = msg.content.map((block) => {
      if (block.type === 'tool_result' && trimSet.has(block.tool_use_id)) {
        touched = true;
        return {
          ...block,
          output: { type: 'text' as const, value: TRIMMED_TOOL_RESULT_PLACEHOLDER },
        };
      }
      return block;
    });
    return touched ? { ...msg, content: newContent } : msg;
  });
}

// ---------------- 压缩阈值 ----------------

/** 默认压缩阈值比例（contextWindow × 0.8，留 20% 给本轮回复 + 工具结果） */
const COMPRESS_THRESHOLD_RATIO = 0.8;

/** 估算当前 messages 的 token 数是否超过压缩阈值 */
export function isOverThreshold(model: string, system: string, messages: ECodeMessage[]): {
  over: boolean;
  tokens: number;
  threshold: number;
} {
  const contextWindow = getContextWindow(model);
  const threshold = Math.floor(contextWindow * COMPRESS_THRESHOLD_RATIO);
  const tokens = countTokens(model, system, messages);
  return { over: tokens > threshold, tokens, threshold };
}

// ---------------- 压缩 prompt 构造（P3-3）----------------

/**
 * 构造压缩 prompt（参考 Claude Code 9 段式 `prompt.ts:61-143`）。
 *
 * 压缩质量直接决定 agent 会不会"失忆"（M3-方案解析 §5.2/5.3）：
 * - 必须保留：用户目标、已做的关键操作及结论、重要事实（文件内容/bug 位置/决策）
 * - 必须丢弃：冗余的工具原始输出、重复信息
 * - 禁止编造未发生的事
 *
 * ECode 的 summarize 注入点天然不带 tools，无需 Claude Code 的三重禁工具保险
 * （NO_TOOLS_PREAMBLE/TRAILER + createCompactCanUseTool deny）。
 */
export function buildCompressPrompt(earlyConversation: string): string {
  return `你是对话历史压缩器。把以下早期对话压缩成一段简洁摘要。

重点保留：
1. 用户的核心目标（要做什么）
2. 已做过的关键操作及结论（读了哪些文件、改了什么、测试结果）
3. 已知的重要事实（bug 位置、关键代码片段、已做的决策）

丢弃：
- 冗余的工具原始输出（大段文件内容、命令日志）
- 重复信息

要求：
- 用第三人称客观陈述
- 不要编造未发生的事
- 控制在 500 字以内

以下是早期对话：
${earlyConversation}`;
}

// ============================================================
// maybeCompress 门面（P3-2 实现）
// ============================================================

export interface CompressOptions {
  model: string;
  system: string;
  /** 压缩用的 LLM 调用（注入，便于测试 mock）。输入早期对话文本，返回摘要 */
  summarize: (prompt: string) => Promise<string>;
  /** 保留最近 N 个往返组（默认 6） */
  keepRounds?: number;
}

export interface CompressResult {
  messages: ECodeMessage[];
  compressed: boolean;
  /** 压缩是否成功（false = 压缩失败已降级跳过） */
  success: boolean;
}

/**
 * 门面：agent loop 每轮 API 调用前调这一个方法。
 * - 未超阈值：原样返回
 * - 超阈值：**级联压缩**（L2 先 trim 零成本 → 不够再 L3 summary）
 * - 压缩失败：降级返回原 messages（不阻塞 loop）
 *
 * 级联思想（仿 CCode `ContextManager.prepare`：先 tool-trim 不够再 summary）：
 * trim 是零 LLM 成本且不破坏配对,能省一次摘要调用就省。
 */
export async function maybeCompress(
  messages: ECodeMessage[],
  opts: CompressOptions,
): Promise<CompressResult> {
  const { over } = isOverThreshold(opts.model, opts.system, messages);
  if (!over) {
    return { messages, compressed: false, success: true };
  }

  try {
    // 级联 1: tool-result 内容清空(零 LLM 成本)
    const trimmed = trimToolResultContents(messages);
    // trim 后若不再超限 → 直接用 trim 结果,省一次 LLM 摘要
    if (!isOverThreshold(opts.model, opts.system, trimmed).over) {
      return { messages: trimmed, compressed: true, success: true };
    }
    // 级联 2: trim 后仍超 → LLM 摘要(在已 trim 的基础上,摘要更便宜)
    const compressed = await compressMessages(trimmed, opts);
    return { messages: compressed, compressed: true, success: true };
  } catch (err) {
    // 压缩失败 → 降级：跳过压缩继续 loop，不阻塞（M3-方案解析 §5.5）
    console.error(
      `⚠️  上下文压缩失败，降级跳过: ${err instanceof Error ? err.message : err}`,
    );
    return { messages, compressed: false, success: false };
  }
}

// ---------------- L3: 响应式恢复(API 报超限后的兜底)----------------

/**
 * 识别"context window 超限"类 API 错误,触发响应式恢复(L3)。
 * 覆盖各家协议的错误措辞(Claude Code `isPromptTooLongMessage` 同款思路,扩展到多协议):
 * - GLM/DeepSeek: "reached its context window limit" / "context window"
 * - Anthropic: "prompt is too long"（400）
 * - OpenAI 标准: "maximum context length" / 错误码 "context_length_exceeded"
 */
export function isContextWindowError(err: unknown): boolean {
  if (err == null) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('context window') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded')
  );
}

/**
 * 响应式强制压缩：API 报 context-window 错后的兜底（L3）。
 * 比 maybeCompress 更激进：
 *   1. trim 只保留最近 1 个 tool_result 原文(默认是 3)
 *   2. 仍超则上 summary,keepRounds 降到 2(默认是 6)
 *
 * 返回值：
 *   - 非 null：压到阈值以下的 messages（保证下次 API 调用不再超限）
 *   - null：压到极限仍超限（如单个 tool_result 本身 > 窗口）→ **L4 熔断**,
 *     调用方应放弃恢复、向上抛错,避免"compact→still too long→compact"死循环
 *     （Claude Code `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` 同款防护）。
 */
export async function forceCompact(
  messages: ECodeMessage[],
  opts: CompressOptions,
): Promise<ECodeMessage[] | null> {
  // 激进 trim：只保留最近 1 个 tool_result 原文
  let result = trimToolResultContents(messages, 1);

  // trim 后仍超 → 上 summary（keepRounds 降到 2,激进保留更少近期往返）
  if (isOverThreshold(opts.model, opts.system, result).over) {
    try {
      result = await compressMessages(result, { ...opts, keepRounds: 2 });
    } catch {
      return null; // summary 失败 → 压不动
    }
  }

  // 最终仍超限 → 压不动(返回 null = 熔断,避免无谓重试)
  if (isOverThreshold(opts.model, opts.system, result).over) {
    return null;
  }
  return result;
}

// ---------------- 压缩算法实现 ----------------

/**
 * 压缩 messages：切分 → 摘要早期 → 拼装 → 配对校验。
 *
 * 摘要作为一条新 user 消息插入，标注"这是压缩摘要"。
 * 输出仍是标准 ECodeMessage[]（数据结构不变，agent loop 无感知）。
 */
async function compressMessages(
  messages: ECodeMessage[],
  opts: CompressOptions,
): Promise<ECodeMessage[]> {
  const { early, recent } = splitForCompression(messages, { keepRounds: opts.keepRounds });

  // 无待压缩内容（理论上不该发生，因为已超阈值）→ 原样返回
  if (early.length === 0) {
    return messages;
  }

  // 调注入的 summarize 生成摘要（用压缩 prompt 包裹序列化的早期对话）
  const earlyText = serializeForSummary(early);
  const summaryText = await opts.summarize(buildCompressPrompt(earlyText));

  // 摘要作为新 user 消息 + 保留的 recent 消息
  const summaryMessage: ECodeMessage = {
    role: 'user',
    content: `[上下文压缩摘要] 以下是早期对话的摘要：\n\n${summaryText}`,
  };
  const result: ECodeMessage[] = [summaryMessage, ...recent];

  // 配对完整性校验（最后防线）：recent 必须配对完整（early 已被摘要替代，无工具 id）
  if (!verifyMessagesPairing(result)) {
    throw new Error('压缩破坏了 tool_use/tool_result 配对（recent 含孤儿）');
  }

  return result;
}

/** 把早期 messages 序列化成摘要 prompt 用的文本 */
function serializeForSummary(messages: ECodeMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      lines.push(`[${msg.role}] ${msg.content}`);
    } else {
      for (const block of msg.content) {
        const text = blockToText(block);
        if (text) lines.push(`[${msg.role}] ${text}`);
      }
    }
  }
  return lines.join('\n');
}

/** 单个 content block → 摘要用的文本片段 */
function blockToText(block: ECodeContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_call':
      return `调用工具 ${block.name}（参数: ${JSON.stringify(block.input)}）`;
    case 'tool_result':
      return `工具结果: ${outputToText(block.output)}`;
  }
}

/** tool_result output → 文本 */
function outputToText(output: ECodeToolResultOutput): string {
  switch (output.type) {
    case 'text':
      return output.value;
    case 'error':
      return `[错误] ${output.value}`;
    case 'json':
      return JSON.stringify(output.value);
  }
}
