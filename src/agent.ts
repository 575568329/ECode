import { toolDefinitions, executeTool } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { withRetry } from './retry.js';
import { createProvider } from './providers/factory.js';
import { getDefaultModel, hasCapability } from './providers/config.js';
import type { ECodeMessage } from './providers/types.js';
import {
  initRuntimeLog,
  logApiRequest,
  logApiResponse,
  logToolExecution,
  logError,
  finalizeRuntimeLog,
} from './runtime-logger.js';

// ============================================================
// Agent Loop — 理解 Agent 的心脏
// ============================================================
//
// 原理：
//   agent 是一个 while 循环，每次迭代：
//   1. 把累积的 messages 发给 LLM（经 Provider 抽象，不绑死某家协议）
//   2. LLM 返回 text（思考/回答）或 tool_call（工具调用请求）
//   3. 如果是 tool_call → 执行工具 → 回传 tool_result → 继续循环
//   4. 如果是 text → 终止循环
//
// 关键约束：
//   - tool_result.tool_use_id 必须等于 tool_call.id（不配对会 400）
//   - messages 是累加的（append 不是重建），每次循环传全部历史
//
// M2 改造：agent 不再 import 任何 SDK，只依赖 ModelProvider 接口 + ECode 内部格式。
// ============================================================

const MAX_ITERATIONS = 25;

export async function runAgent(task: string, model?: string): Promise<void> {
  const resolvedModel = model ?? getDefaultModel();
  const provider = createProvider(resolvedModel);
  const useTools = hasCapability(resolvedModel, 'tools');

  // 初始化运行时日志（实时写入 docs/logs/runtime/）
  const logFile = initRuntimeLog(task, resolvedModel);

  // 消息历史 —— 整个 agent 的"记忆"（ECode 内部格式，与协议无关）
  const messages: ECodeMessage[] = [{ role: 'user', content: task }];

  const tools = useTools ? toolDefinitions : [];

  console.log(`\n🤖 ECode (model: ${resolvedModel}, provider: ${provider.name})`);
  console.log(`📝 任务: ${task}`);
  console.log(`📋 日志: ${logFile}\n`);

  let iteration: number;
  let lastSignature = '';
  let repeated = false;
  for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // ---- 日志：API 请求 ----
    logApiRequest(iteration, messages, tools);

    // ---- 调用 LLM（经 Provider 抽象，带重试）----
    const response = await withRetry(
      () =>
        provider.complete({
          model: resolvedModel,
          system: buildSystemPrompt(),
          messages,
          tools,
        }),
      `provider:${resolvedModel}`,
    ).catch((err) => {
      logError(`API call (round ${iteration})`, err);
      throw err;
    });

    // ---- 日志：API 响应 ----
    logApiResponse(iteration, response.content, response.stopReason, response.usage);

    // 打印 transform 降级/不支持警告（让用户知道模型悄悄丢了什么）
    if (response.warnings && response.warnings.length > 0) {
      for (const w of response.warnings) {
        console.log(`⚠️  [${w.type}] ${w.feature}${w.details ? ` (${w.details})` : ''}`);
      }
    }

    // ---- 处理 LLM 返回的内容块（ECode 统一格式）----
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        process.stdout.write(block.text);
      } else if (block.type === 'tool_call') {
        toolUseBlocks.push({ id: block.id, name: block.name, input: block.input });
      }
      // tool_result 不会出现在 LLM 响应里
    }

    // 没有工具调用 → LLM 已给出最终回答，循环终止
    if (toolUseBlocks.length === 0) {
      console.log('\n');
      break;
    }

    // ---- 把 LLM 的完整回复加入消息历史（含 text + tool_call blocks）----
    messages.push({ role: 'assistant', content: response.content });

    // ---- 执行每个工具，回传 tool_result（ECode 格式）----
    for (const toolUse of toolUseBlocks) {
      console.log(`\n\n⚡ [${toolUse.name}]`);

      // 防御:工具实现抛异常时降级为 isError 回喂 LLM,不让单个工具崩杀整个 loop
      let result: { content: string; isError: boolean };
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (err) {
        result = {
          content: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      logToolExecution(iteration, toolUse.name, toolUse.input, result.content, result.isError);

      if (result.isError) {
        console.log(`❌ 错误: ${result.content.slice(0, 300)}`);
      } else {
        const preview = result.content.split('\n').slice(0, 5).join('\n');
        console.log(`✅ 完成 (${result.content.length} 字符)`);
        if (preview) {
          console.log(`  └─ ${preview.replace(/\n/g, '\n     ')}`);
        }
      }

      // 回传 tool_result —— id 必须配对！
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          },
        ],
      });
    }

    // ---- 重复动作检测（防死循环）：连续两轮工具调用签名相同 → 终止 ----
    const signature = toolUseBlocks
      .map((t) => `${t.name}:${JSON.stringify(t.input)}`)
      .sort()
      .join(' || ');
    if (signature === lastSignature) {
      console.log('\n⚠️  检测到连续重复的工具调用，终止以防死循环。');
      logError('重复动作检测', `签名: ${signature}`);
      repeated = true;
      break;
    }
    lastSignature = signature;

    const toolNames = toolUseBlocks.map((t) => t.name).join(', ');
    console.log(`\n  ── 第 ${iteration + 1} 轮结束 (调用了 ${toolUseBlocks.length} 个工具: ${toolNames}) ──\n`);
  }

  // 完成日志
  finalizeRuntimeLog(iteration + 1);

  // 终止原因：重复动作（loop 内已打印警告）/ 跑满上限 / 正常结束
  if (!repeated && iteration >= MAX_ITERATIONS) {
    console.log(`\n⚠️  达到最大迭代次数 (${MAX_ITERATIONS})，自动终止`);
  }
}
