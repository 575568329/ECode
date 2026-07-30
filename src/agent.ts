import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
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
//   1. 把累积的 messages 发给 LLM
//   2. LLM 返回 text（思考/回答）或 tool_use（工具调用请求）
//   3. 如果是 tool_use → 执行工具 → 回传 tool_result → 继续循环
//   4. 如果是 text → 终止循环
//
// 关键约束：
//   - tool_result.tool_use_id 必须等于 tool_use.id（不配对会 400）
//   - messages 是累加的（append 不是重建），每次循环传全部历史
// ============================================================

const MAX_ITERATIONS = 25;

export async function runAgent(task: string): Promise<void> {
  // 兼容两种鉴权：
  //   - ANTHROPIC_API_KEY   官方 Claude（x-api-key 头）
  //   - ANTHROPIC_AUTH_TOKEN 兼容端点如 DeepSeek（Authorization: Bearer 头）
  // 二者至少给一个；BASE_URL 留空走官方，填了走兼容端点。
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const authToken = process.env['ANTHROPIC_AUTH_TOKEN'];
  if (!apiKey && !authToken) {
    console.error('错误: 未设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN');
    console.error('请创建 .env 文件（参考 .env.example）填入 key，或直接 export');
    process.exit(1);
  }

  const anthropic = new Anthropic({
    apiKey: apiKey ?? undefined,
    authToken: authToken ?? undefined,
    baseURL: process.env['ANTHROPIC_BASE_URL'],
  });
  // 默认走 DeepSeek；切官方 Claude 时在 .env 覆盖 ANTHROPIC_MODEL
  const model = process.env['ANTHROPIC_MODEL'] || 'deepseek-v4-pro';

  // 初始化运行时日志（实时写入 docs/logs/runtime/）
  const logFile = initRuntimeLog(task, model);

  // 消息历史 —— 整个 agent 的"记忆"
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: task },
  ];

  console.log(`\n🤖 ECode (model: ${model})`);
  console.log(`📝 任务: ${task}`);
  console.log(`📋 日志: ${logFile}\n`);

  let iteration: number;
  for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // ---- 日志：API 请求 ----
    logApiRequest(iteration, messages, toolDefinitions);

    // ---- 调用 LLM ----
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages,
      tools: toolDefinitions,
    }).catch((err) => {
      logError(`API call (round ${iteration})`, err);
      throw err;
    });

    // ---- 日志：API 响应 ----
    const usage = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : undefined;
    logApiResponse(iteration, response.content, response.stop_reason ?? 'unknown', usage);

    // ---- 处理 LLM 返回的内容块 ----
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        // LLM 的文本回复（思考过程/最终答案）
        process.stdout.write(block.text);
      } else if (block.type === 'tool_use') {
        // LLM 请求调用工具
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    // 没有工具调用 → LLM 已给出最终回答，循环终止
    if (toolUseBlocks.length === 0) {
      console.log('\n');
      break;
    }

    // ---- 把 LLM 的完整回复加入消息历史 ----
    // 注意：必须包含所有 content block（既包括 text 也包括 tool_use）
    messages.push({
      role: 'assistant',
      content: response.content,
    });

    // ---- 执行每个工具，回传 tool_result ----
    for (const toolUse of toolUseBlocks) {
      console.log(`\n\n⚡ [${toolUse.name}]`);

      const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>);

      // 日志：工具执行
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

    const toolNames = toolUseBlocks.map((t) => t.name).join(', ');
    console.log(`\n  ── 第 ${iteration + 1} 轮结束 (调用了 ${toolUseBlocks.length} 个工具: ${toolNames}) ──\n`);
  }

  // 完成日志
  finalizeRuntimeLog(iteration + 1);

  // 判断是否真的跑满上限：
  //   break 退出 → iteration 是 break 那一轮（< MAX_ITERATIONS），正常结束
  //   跑满退出 → for 自然结束，iteration === MAX_ITERATIONS，才需要警告
  // （旧实现用 typeof content === 'string' 判断，但 assistant 的 content 恒为数组，
  //  条件永假 → 每次都误报警告，已弃用）
  if (iteration >= MAX_ITERATIONS) {
    console.log(`\n⚠️  达到最大迭代次数 (${MAX_ITERATIONS})，自动终止`);
  }
}
