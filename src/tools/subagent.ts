// 支点 9 子代理 —— Task 工具（递归 runAgentStream，侦察兵模式）。
//
// 设计要点（见 M5-实施方案 §阶段1 + §五权限⊆）：
//   - **不静态注册**：Task 工具在 runAgentStream 内动态构造（createTaskTool 闭包），
//     捕获主代理当前的 system/allow/mode/denyRules/gate/provider/model/depth，
//     使子代理天然「权限⊆」（继承全部 + 人设 tools 收紧）+ 防递归，无需全局态。
//   - **侦察兵/黑盒**：子代理独立 messages，drain 事件只取最终 assistant text 回喂主，
//     不 yield 中间 tool 调用（防主上下文污染 + 主代理退化为传话筒）。
//   - **防递归**：深度硬限制，默认子代理不能再派子代理（maxDepth=1）。
//   - **ask 归主对话**：子代理共享主 permissionGate，弹窗在主 REPL。
import type { ToolDefinition, ToolResult } from './types.js';
import { toolDefinitions } from './registry.js';
import { runAgentStream } from '../agent.js';
import { loadAgents } from '../subagent/loader.js';
import { AllowList } from '../permission.js';
import type { PermissionGate } from '../permission.js';
import type { ModelProvider, ECodeMessage } from '../providers/types.js';
import type { PermissionMode, Rule } from '../permission/types.js';

/** 默认子代理嵌套深度上限：子代理默认不能再派子代理（防递归爆炸）。 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

/** createTaskTool 闭包捕获的主代理上下文（实现权限⊆ + 防递归 + 上下文继承）。 */
export interface TaskToolContext {
  /** 主代理 system（含 CLAUDE.md），无 persona 时子代理继承它。 */
  system: string;
  /** 共享主 AllowList 实例（A 方案：继承全部，子代理批准的回写主，不建独立实例）。 */
  allow: AllowList;
  permissionMode: PermissionMode;
  /** 主代理 denyRules（透传，子代理继承硬规则）。 */
  denyRules?: Rule[];
  /** 共享主 permissionGate（ask 弹窗归主对话，子代理不自己弹窗）。 */
  gate?: PermissionGate;
  provider?: ModelProvider;
  model?: string;
  /** 当前嵌套深度（主代理 = 0；子代理递归时 +1，由 runAgentStream opts.subagentDepth 传入）。 */
  depth: number;
  /** 深度上限（默认 DEFAULT_MAX_SUBAGENT_DEPTH）。 */
  maxDepth?: number;
}

/**
 * 从 completed 事件的 messages 里取「最终 assistant 文本」= 子代理结论（侦察兵只回这个）。
 * 跳过 tool_use 块，取最末 assistant 消息的 text；无 → 空串。
 */
export function extractFinalText(messages: ECodeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    // ECodeMessage.content 可能是 string（纯文本）或 ECodeContentBlock[]（含 text/tool_use）。
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) return content;
      continue;
    }
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

/**
 * 构造 Task 工具（runAgentStream 内调用，闭包捕获主代理权限上下文）。
 * 返回的 ToolDefinition 递归 runAgentStream 跑子代理，黑盒回收结论文本。
 */
export function createTaskTool(ctx: TaskToolContext): ToolDefinition {
  const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  return {
    name: 'Task',
    description:
      '派遣子代理独立完成子任务（独立上下文），只回最终结论。适合读/分析大量文件、并行处理多模块，避免污染主上下文。',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '子任务一句话描述（给用户看进度）' },
        prompt: { type: 'string', description: '给子代理的完整指令' },
        agent: { type: 'string', description: '可选：派专项人设（.ecode/agents/*.md 的 name）' },
      },
      required: ['description', 'prompt'],
    },
    execute: async (input): Promise<ToolResult> => {
      const { prompt, agent } = input as { description: string; prompt: string; agent?: string };

      // 嵌套深度硬限制：子代理默认不能再派子代理（防递归爆炸）。
      if (ctx.depth >= maxDepth) {
        return { content: `子代理嵌套深度超限（上限 ${maxDepth}），拒绝派发`, isError: true };
      }

      // 选人设：命中则用其 systemPrompt + tools 子集；否则继承主 system + 全工具。
      const persona = agent ? loadAgents().find((a) => a.name === agent) : undefined;
      const subSystem = persona?.systemPrompt ?? ctx.system;
      const subTools = persona?.tools
        ? toolDefinitions.filter((t) => persona.tools!.includes(t.name)) // 人设收紧工具子集
        : toolDefinitions;

      // 递归 runAgentStream（黑盒：drain 只取最终 assistant text，不泄露中间 tool 调用到主上下文）。
      let conclusion = '';
      for await (const event of runAgentStream(prompt, {
        system: subSystem,
        tools: subTools,
        allow: ctx.allow, // 共享主 AllowList（A 方案权限⊆）
        permissionMode: ctx.permissionMode,
        denyRules: ctx.denyRules,
        permissionGate: ctx.gate, // ask 归主对话
        provider: ctx.provider,
        model: ctx.model ?? persona?.model,
        subagentDepth: ctx.depth + 1, // 子代理深度 +1，其 Task 闭包据此拦再递归
      })) {
        if (event.type === 'completed') conclusion = extractFinalText(event.messages);
        if (event.type === 'error') return { content: `子代理执行失败: ${event.error}`, isError: true };
      }
      return { content: conclusion || '（子代理未产出文本结论）', isError: false };
    },
  };
}
