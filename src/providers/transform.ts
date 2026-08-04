import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ChatRequest, ECodeContentBlock, ECodeMessage, ECodeResponse, ECodeStopReason, ECodeToolDefinition, ECodeWarning } from './types.js';

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
    max_tokens: req.maxTokens ?? 4096,
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
): Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
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
  return {
    content: blocks,
    stopReason: mapAnthropicStopReason(res.stop_reason),
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
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
    max_tokens: req.maxTokens ?? 4096,
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
      // user：tool_result → role:'tool'，text → role:'user'
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          // v2: output 判别联合 → OpenAI role:tool content
          result.push({ role: 'tool', tool_call_id: b.tool_use_id, content: outputToOpenAIContent(b.output) });
        } else if (b.type === 'text') {
          result.push({ role: 'user', content: b.text });
        }
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
