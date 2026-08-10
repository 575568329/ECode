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
import { subagentBaseDir } from '../session.js';
import { resolveModelForSubagent } from '../router/rules.js';
import type { RoutingConfig, RoutingSource } from '../router/rules.js';
import { createProvider } from '../providers/factory.js';
import { logWarning, subagentLogRoot } from '../runtime-logger.js';

/** 默认子代理嵌套深度上限：子代理默认不能再派子代理（防递归爆炸）。 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

/** createTaskTool 闭包捕获的主代理上下文（实现权限⊆ + 防递归 + 上下文继承）。 */
export interface TaskToolContext {
  /** 主代理 system（含 CLAUDE.md），无 persona 时子代理继承它。 */
  system: string;
  /** 共享主 AllowList 实例（A 方案：继承全部，子代理批准的回写主，不建独立实例）。 */
  allow: AllowList;
  /** 权限档动态读取（主代理 Shift+Tab 切换即时传递给子代理）。子代理 runAgentStream 启动时读当前值。 */
  getPermissionMode: () => PermissionMode;
  /** 主代理 denyRules（透传，子代理继承硬规则）。 */
  denyRules?: Rule[];
  /** 共享主 permissionGate（ask 弹窗归主对话，子代理不自己弹窗）。 */
  gate?: PermissionGate;
  provider?: ModelProvider;
  model?: string;
  /** 路由配置（runAgentStream 入口解析，子代理据此走 subagent 场景路由）。可选：测试不传则回退 ctx.model。 */
  routingConfig?: RoutingConfig;
  /** 当前嵌套深度（主代理 = 0；子代理递归时 +1，由 runAgentStream opts.subagentDepth 传入）。 */
  depth: number;
  /** 深度上限（默认 DEFAULT_MAX_SUBAGENT_DEPTH）。 */
  maxDepth?: number;
  /** Session 落盘根目录透传（测试隔离用 tmpdir；不传 → 默认 cwd/.ecode/sessions）。
   *  实际落盘到 <baseDir>/_subagents（见 subagentBaseDir），与主会话隔离，不进 /resume 列表。 */
  sessionBaseDir?: string;
  /** Runtime log 根目录透传（测试隔离用 tmpdir；不传 → 子代理走默认 docs/logs/runtime）。 */
  runtimeLogBaseDir?: string;
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

      // 路由解析（R3）：complexityRouting 分支 + 跨 provider 解耦 + 来源标注（供 UI 气泡 §16.5）。
      // 有 routingConfig → resolveModelForSubagent（persona > complexity > rule > default，provider 从落点取）；
      //   落点 provider 与主不同 → 建独立 provider（不再继承主，支持跨 provider 子代理）。
      // 无 routingConfig → 回退 ctx.model ?? persona.model（行为不变，测试/未配路由路径）。
      let subProvider = ctx.provider;
      let subModel: string | undefined;
      let routingSource: RoutingSource | undefined;
      if (ctx.routingConfig) {
        const r = resolveModelForSubagent(
          { personaModel: persona?.model, taskDesc: prompt },
          ctx.routingConfig,
        );
        subModel = r.model;
        routingSource = r.source;
        // 跨 provider：主 provider 存在且落点 provider 不同 → 按新 model 建独立 provider（解耦）。
        // 落点 provider 未配置（API Key/模型缺失）→ 退回主 provider（鲁棒降级，§9.3）：
        //   主 provider 不识别落点 model 时会在 LLM 调用层报错（不静默吞），测试 mock provider 也不校验 model；
        //   清空 routingSource：实际未按落点 provider 执行，避免 UI 气泡标注误导。
        if (ctx.provider && r.provider !== ctx.provider.name) {
          try {
            subProvider = createProvider(r.model);
          } catch (err) {
            // 降级到主 provider（§9.3）：落点 provider 建立失败（model 未配置 / API Key 缺失）。
            // 记 warning 供排查（非 isError——子代理仍可跑，只是没按路由落点执行）。
            logWarning(
              'subagent-route',
              `跨 provider 路由降级：落点 ${r.model}(${r.provider}) provider 建立失败（${
                err instanceof Error ? err.message : String(err)
              }），回退主 provider ${ctx.provider.name}`,
            );
            subProvider = ctx.provider;
            routingSource = undefined;
          }
        }
      } else {
        subModel = ctx.model ?? persona?.model;
      }

      // 递归 runAgentStream（黑盒：drain 只取最终 assistant text，不泄露中间 tool 调用到主上下文）。
      let conclusion = '';
      for await (const event of runAgentStream(prompt, {
        system: subSystem,
        tools: subTools,
        allow: ctx.allow, // 共享主 AllowList（A 方案权限⊆）
        permissionMode: ctx.getPermissionMode(),
        denyRules: ctx.denyRules,
        permissionGate: ctx.gate, // ask 归主对话
        provider: subProvider,
        model: subModel,
        subagentDepth: ctx.depth + 1, // 子代理深度 +1，其 Task 闭包据此拦再递归
        // 隔离到 <baseDir>/_subagents：子代理是黑盒，其 session 上下文不该进用户历史列表
        // （listSessions 非递归，子目录不显示），runtime-log 同理隔离避免淹没主日志目录。
        sessionBaseDir: subagentBaseDir(ctx.sessionBaseDir),
        runtimeLogBaseDir: subagentLogRoot(ctx.runtimeLogBaseDir),
      })) {
        if (event.type === 'completed') conclusion = extractFinalText(event.messages);
        if (event.type === 'error') return { content: `子代理执行失败: ${event.error}`, isError: true };
      }
      const result: ToolResult = { content: conclusion || '（子代理未产出文本结论）', isError: false };
      // 有路由来源 → 填 metadata（供 Task 气泡显示模型+来源，§16.5）；无 routingConfig 不填（向后兼容）。
      if (routingSource) {
        result.metadata = { model: subModel, provider: subProvider?.name, routingSource };
      }
      return result;
    },
  };
}
