// messagesToDisplayMessages —— 历史会话 ECodeMessage[] → DisplayMessage[]（/resume 载入渲染用）。
// 纯函数：把 session.ts 落盘的 LLM messages 还原成 UI 渲染层 DisplayMessage。
// 方向单向（LLM→UI）；严禁反向——types.ts line 1-3 注释明令不得从 DisplayMessage[] 重建 messages。
//
// 配对规则（详设 docs/20260806210000_历史会话切换-详设.md §3.5）：
//   assistant 的 tool_call block 记入 toolCallMap（按 id），等 user 的 tool_result block
//   配对补全 name/input 后产 tool 消息。孤儿 tool_call（无配对 result）跳过；无配对 call 的
//   result 用 tool_use_id 兜底 name。多 text block 合并为一条 assistant 文本。
import type { ECodeMessage, ECodeToolResultOutput } from '../providers/types.js';
import type { DisplayMessage } from './types.js';

let histSeq = 0;
const nextHistId = (): string => `h${++histSeq}`;

/** ECodeToolResultOutput → 字符串 content：text/error 取 value；json 序列化。 */
function outputToString(output: ECodeToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error':
      return output.value;
    case 'json':
      return JSON.stringify(output.value);
  }
}

/**
 * 历史还原：ECodeMessage[] → DisplayMessage[]。
 * @param messages session.ts 落盘的完整 LLM 历史
 * @param model 可选模型名，补到 assistant 消息（MetaLine 数据源；由 session.model 传入）
 */
export function messagesToDisplayMessages(messages: ECodeMessage[], model?: string): DisplayMessage[] {
  // tool_call id → {name, input}，供配对的 tool_result 补全（跨消息配对，按 tool_use_id）
  const toolCallMap = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: DisplayMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // string content → 单条 user 文本（首轮常见）
      if (typeof msg.content === 'string') {
        out.push({ kind: 'user', id: nextHistId(), text: msg.content });
        continue;
      }
      // blocks：text → user 文本；tool_result → 配对产 tool 消息
      for (const block of msg.content) {
        if (block.type === 'text') {
          out.push({ kind: 'user', id: nextHistId(), text: block.text });
        } else if (block.type === 'tool_result') {
          const call = toolCallMap.get(block.tool_use_id);
          out.push({
            kind: 'tool',
            id: nextHistId(),
            name: call?.name ?? block.tool_use_id, // 无配对 call：用 id 兜底
            content: outputToString(block.output),
            isError: block.output.type === 'error',
            input: call?.input,
          });
        }
        // tool_call 不应出现在 user role，忽略
      }
    } else {
      // assistant：string → 单条；blocks：合并 text 为一条，tool_call 记入 map（等配对）
      if (typeof msg.content === 'string') {
        out.push({ kind: 'assistant', id: nextHistId(), text: msg.content, model });
        continue;
      }
      const textParts: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_call') {
          toolCallMap.set(block.id, { name: block.name, input: block.input });
        }
      }
      // 纯 tool_call（无 text）的 assistant 不产 assistant 文本——等 result 配对产 tool 消息
      if (textParts.length > 0) {
        out.push({ kind: 'assistant', id: nextHistId(), text: textParts.join(''), model });
      }
    }
  }

  return out;
}
