import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ChatRequest, ECodeContentBlock, ECodeMessage, ECodeResponse, ECodeStopReason, ECodeToolDefinition, ECodeWarning } from './types.js';

/**
 * Anthropic prompt caching 用量字段（运行时随响应返回，但 SDK 0.32.1 的 Usage 类型未声明）。
 * 用类型断言访问——cache 开启时 API JSON 实带这些字段，类型缺口不应导致丢数据（呼应 P5「usage 保真」）。
 */
export type AnthropicCacheUsage = {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// ============================================================
// Transform —— 内部格式 ↔ 两家协议的双向翻译（纯函数，无副作用）
// ============================================================
// 这层是 M2 的核心：agent loop 只认 ECode 内部格式，Provider 调这里的函数
// 翻译成各家 SDK 能接受的形状，再把 SDK 返回翻译回 ECode 格式。
// 纯函数 → 易测（不依赖网络/SDK 实例，只做数据结构转换）。
// ============================================================

// ---------------- ECode → Anthropic ----------------

/** 把 ECode 请求翻译成 Anthropic messages.create 参数 */
export function toAnthropicRequest(req: ChatRequest): Anthropic.MessageCreateParams {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 16384,
    system: req.system,
    messages: req.messages.map(toAnthropicMessage),
    tools: req.tools.length > 0 ? req.tools.map(toAnthropicTool) : undefined,
  };
}

function toAnthropicMessage(msg: ECodeMessage): Anthropic.MessageParam {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  return { role: msg.role, content: msg.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(
  block: ECodeContentBlock,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: block.source.data,
        },
      };
    case 'tool_call':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      // v2: output 判别联合 → Anthropic 原生格式
      // content: text/error 统一为字符串；is_error: 仅 error variant 设为 true
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: outputToAnthropicContent(block.output),
        ...(block.output.type === 'error' ? { is_error: true as const } : {}),
      };
    default:
      // exhaustive check:新增 ECodeContentBlock variant 时编译报错,防漏
      const _: never = block;
      throw new Error(`unsupported block type: ${JSON.stringify(_)}`);
  }
}

function toAnthropicTool(tool: ECodeToolDefinition): Anthropic.Tool {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/** 把 Anthropic Message 翻译回 ECodeResponse（丢掉 thinking 等不关心的 block） */
export function fromAnthropicResponse(res: Anthropic.Message): ECodeResponse {
  const blocks: ECodeContentBlock[] = [];
  const warnings: ECodeWarning[] = [];
  for (const b of res.content) {
    if (b.type === 'text') {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      blocks.push({
        type: 'tool_call',
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      });
    } else {
      // thinking / 其它 block → 降级记录而非静默丢失
      // TS 收窄为 never:所有已知 ContentBlock 变体已在上面处理,
      // 但 SDK 可能返回新变体(如 future 新 block type),用类型断言兜底
      const unknownBlock = b as { type: string };
      warnings.push({ type: 'unsupported', feature: `content block type '${unknownBlock.type}'` });
    }
  }
  // Anthropic cache 用量字段 SDK 0.32.1 类型未声明（运行时随 prompt caching 响应返回），断言访问
  const cacheU = res.usage as AnthropicCacheUsage;
  return {
    content: blocks,
    stopReason: mapAnthropicStopReason(res.stop_reason),
    usage: {
      // inputTokens 统一为「总输入（含 cache）」，与 OpenAI 的 prompt_tokens 语义对齐——
      // 支点17 cost 精确化前提：两家 inputTokens 含义一致，computeCost 才能用统一公式
      // （非缓存 = 总输入 - cacheRead - cacheWrite）正确计费，且 ctx% 把 cache 也算进窗口。
      inputTokens:
        res.usage.input_tokens +
        (cacheU.cache_read_input_tokens ?? 0) +
        (cacheU.cache_creation_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
      ...(cacheU.cache_read_input_tokens != null && {
        cacheReadTokens: cacheU.cache_read_input_tokens,
      }),
      ...(cacheU.cache_creation_input_tokens != null && {
        cacheWriteTokens: cacheU.cache_creation_input_tokens,
      }),
    },
    warnings,
  };
}

function mapAnthropicStopReason(reason: Anthropic.Message['stop_reason']): ECodeStopReason {
  switch (reason) {
    case 'end_turn':
      return { unified: 'stop', raw: reason };
    case 'tool_use':
      return { unified: 'tool-use', raw: reason };
    case 'stop_sequence':
      return { unified: 'stop', raw: reason }; // 模型主动停止（非 max_tokens）
    default: // max_tokens / 其他
      return { unified: 'length', raw: reason ?? undefined };
  }
}

// ---------------- ECode → OpenAI ----------------

/** 把 ECode 请求翻译成 OpenAI chat.completions.create 参数 */
export function toOpenAIRequest(req: ChatRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 16384,
    messages: toOpenAIMessages(req),
    tools: req.tools.length > 0 ? req.tools.map(toOpenAITool) : undefined,
  };
}

/**
 * ECode messages → OpenAI messages。
 * 关键差异：OpenAI 的 tool_result 是独立 role:'tool' 消息（ECode 是 user content block），
 * 故一个 ECode user 消息可能展开成多条 OpenAI 消息（每个 tool_result 一条 role:'tool'）。
 */
export function toOpenAIMessages(req: ChatRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system }, // OpenAI 的 system 在 messages[0]
  ];
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') {
          textParts.push(b.text);
        } else if (b.type === 'tool_call') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
      }
      result.push({
        role: 'assistant',
        content: textParts.join('') || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user：tool_result → role:'tool'，text+image → 合并为一条 role:'user'（content 数组）
      const userContentParts: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          // v2: output 判别联合 → OpenAI role:tool content
          result.push({ role: 'tool', tool_call_id: b.tool_use_id, content: outputToOpenAIContent(b.output) });
        } else if (b.type === 'text') {
          userContentParts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          // ECode image block → OpenAI image_url（data URL 拼接）
          const dataUrl = `data:${b.source.mediaType};base64,${b.source.data}`;
          userContentParts.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
      }
      // 有 text/image part 时合并为一条 user 消息（OpenAI 多模态格式：content 为数组）
      if (userContentParts.length === 1 && userContentParts[0].type === 'text') {
        // 纯文本：用 string content（兼容性更好，部分端点不支持单元素数组）
        result.push({ role: 'user', content: (userContentParts[0] as { text: string }).text });
      } else if (userContentParts.length > 0) {
        result.push({ role: 'user', content: userContentParts });
      }
    }
  }
  return result;
}

function toOpenAITool(tool: ECodeToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/** 把 OpenAI ChatCompletion 翻译回 ECodeResponse */
export function fromOpenAIResponse(res: OpenAI.Chat.ChatCompletion): ECodeResponse {
  const choice = res.choices[0];
  const blocks: ECodeContentBlock[] = [];
  if (choice.message.content) {
    blocks.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== 'function') continue; // 只处理 function 工具调用，跳过 custom
      blocks.push({
        type: 'tool_call',
        id: tc.id,
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments),
      });
    }
  }
  return {
    content: blocks,
    stopReason: mapOpenAIStopReason(choice.finish_reason),
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      ...(res.usage?.prompt_tokens_details?.cached_tokens != null && {
        cacheReadTokens: res.usage.prompt_tokens_details.cached_tokens,
      }),
      ...(res.usage?.completion_tokens_details?.reasoning_tokens != null && {
        reasoningTokens: res.usage.completion_tokens_details.reasoning_tokens,
      }),
    },
  };
}

function mapOpenAIStopReason(reason: string | null | undefined): ECodeStopReason {
  switch (reason) {
    case 'stop':
      return { unified: 'stop', raw: reason };
    case 'tool_calls':
      return { unified: 'tool-use', raw: reason };
    case 'content_filter':
      return { unified: 'content-filter', raw: reason };
    case 'length':
      return { unified: 'length', raw: reason };
    default: // 其他未知值
      return { unified: 'other', raw: reason ?? undefined };
  }
}

function safeParseJSON(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch (err) {
    // 保留原始值和错误信息,不静默吞掉 —— 让 agent loop 能看到 LLM 返回了什么
    return { _parseError: err instanceof Error ? err.message : String(err), _raw: s };
  }
}

// ---------------- ECode v2 output 辅助 ----------------

/**
 * ECodeToolResultOutput → Anthropic tool_result.content 字符串。
 * Anthropic 的 tool_result.content 是 string | array，这里统一用 string。
 * error variant → is_error 由 content block 的 content 决定（需要调用方补充），
 * 但 Anthropic 新版 API 已支持 content block array，error 用 is_error 字段。
 * 简化处理：text/error 统一序列化为 string，is_error 通过输出结构体现。
 */
function outputToAnthropicContent(output: import('./types.js').ECodeToolResultOutput): string {
  switch (output.type) {
    case 'text':
      return output.value;
    case 'error':
      return output.value;
    case 'json':
      return JSON.stringify(output.value);
  }
}

/**
 * ECodeToolResultOutput → OpenAI role:tool 的 content 字段。
 * OpenAI tool message 的 content 是 string | null。
 */
function outputToOpenAIContent(output: import('./types.js').ECodeToolResultOutput): string {
  switch (output.type) {
    case 'text':
      return output.value;
    case 'error':
      return output.value;
    case 'json':
      return JSON.stringify(output.value);
  }
}
