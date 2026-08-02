import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ChatRequest, ECodeContentBlock, ECodeMessage, ECodeResponse, ECodeToolDefinition } from './types.js';

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
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
  }
}

function toAnthropicTool(tool: ECodeToolDefinition): Anthropic.Tool {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/** 把 Anthropic Message 翻译回 ECodeResponse（丢掉 thinking 等不关心的 block） */
export function fromAnthropicResponse(res: Anthropic.Message): ECodeResponse {
  const blocks: ECodeContentBlock[] = [];
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
    }
    // thinking / 其它 block 忽略
  }
  return {
    content: blocks,
    stopReason: mapAnthropicStopReason(res.stop_reason),
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
  };
}

function mapAnthropicStopReason(reason: Anthropic.Message['stop_reason']): ECodeResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    default: // max_tokens / stop_sequence / 其他
      return 'max_tokens';
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
          result.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
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

function mapOpenAIStopReason(reason: string | null | undefined): ECodeResponse['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    default: // length / content_filter / 其他
      return 'max_tokens';
  }
}

function safeParseJSON(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
