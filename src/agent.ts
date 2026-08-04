import { toolDefinitions, executeTool } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { withRetry } from './retry.js';
import { createProvider } from './providers/factory.js';
import { getDefaultModel, hasCapability } from './providers/config.js';
import type {
  ECodeMessage,
  ECodeToolResultOutput,
  ECodeResponse,
  ModelProvider,
  ECodeStreamPart,
  ECodeContentBlock,
} from './providers/types.js';
import { maybeCompress, isContextWindowError, forceCompact } from './context-manager.js';
import {
  initRuntimeLog,
  logApiRequest,
  logApiResponse,
  logToolExecution,
  logError,
  finalizeRuntimeLog,
} from './runtime-logger.js';
import { saveSession } from './session.js';
import type { ECodeSession, ECodeSessionStats } from './session.js';
import type { AgentEvent } from './agent-events.js';
import { shouldAsk, AllowList } from './permission.js';
import type { PermissionGate } from './permission.js';

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

/** 生成 session id:时间戳 YYYYMMDDHHmmss(秒级,单用户 CLI 同秒撞概率极低)。 */
function timestampId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 续接上下文:复用原 session 的 id/首句任务/创建时间,续写同一文件(决策③A)。 */
export interface ResumeContext {
  id: string;
  task: string; // 原会话首句任务(续接不覆盖此字段——§3.4)
  createdAt: string; // 原会话创建时间(保持不变)
  messages: ECodeMessage[];
}

export interface RunAgentOptions {
  resumed?: ResumeContext;
}

// Session 持久化降级状态:首次 save 失败 warn 一次,之后静默 + 写 runtime-log(§6.6 规则4)
let sessionSaveFailed = false;

/**
 * 落盘 session(fire-and-forget):失败绝不杀 agent loop(§6.6)。
 * 首次失败 console.warn 一次提示用户"本次不可 --continue";之后每轮失败静默,只写 runtime-log。
 * saveSession 内部已做原子写(tmp+rename)+ 写盘重试一次。
 */
function persistSession(session: ECodeSession): void {
  try {
    saveSession(session);
  } catch (err) {
    if (!sessionSaveFailed) {
      sessionSaveFailed = true;
      console.warn(
        `⚠️  会话未持久化,本次不可 --continue:${err instanceof Error ? err.message : String(err)}`,
      );
    } else {
      logError('Session 持久化(静默重试)', err);
    }
  }
}

// ============================================================
// runAgentStream —— 事件化 agent loop（M3.5 阶段①核心）
// ============================================================
//
// 与 runAgent 的关系：
//   - runAgent：Promise<void>，内部 console.log 直打印（旧 CLI 入口）
//   - runAgentStream：AsyncGenerator<AgentEvent>，yield 结构化事件（UI 无关）
//   - Task 10 会把 runAgent 改为消费 runAgentStream 事件的 thin wrapper。
//
// 事件流：start → (text_delta | tool_call_start | tool_result | permission_request | warning)*
//         → completed | error
// 关键约束（沿用 runAgent）：
//   - tool_result.tool_use_id 必须配对 tool_use.id（不配对 API 400）
//   - messages 累加；每轮传完整历史
//   - 权限拒绝时仍要 push 一个 isError=true 的 tool_result 保配对不断裂
// ============================================================

export interface RunAgentStreamOptions extends RunAgentOptions {
  model?: string;
  system?: string; // 预拼好的 system（含 CLAUDE.md），不传则 buildSystemPrompt()
  signal?: AbortSignal; // 中断
  allow?: AllowList; // 会话级允许列表（不传则内部 new）
  permissionGate?: PermissionGate; // 权限决策回调（不传 = 全部放行，兼容无 UI / 测试）
  provider?: ModelProvider; // 依赖注入（测试用 mock；生产用 createProvider）
}

/**
 * 把流式 chunk 累积成本轮 ECodeResponse.content（text + tool_call 完整 input）。
 * - text_delta → 追加 text
 * - tool_call_start/delta/end → 按 id 累积 input JSON，跨 chunk 拼接
 * - usage → 暂不用于事件（成本追踪 M5）
 * - stop → 记录 unified 停止原因
 * 中断：迭代中 signal.aborted → 抛 AbortError（DOMException）让外层 catch 收尾。
 */
async function consumeStream(
  gen: AsyncIterable<ECodeStreamPart>,
  signal?: AbortSignal,
): Promise<{
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopUnified: string;
}> {
  let text = '';
  const inputBuf = new Map<string, string>(); // id → 累积的 input JSON 字符串
  const names = new Map<string, string>(); // id → name
  const order: string[] = []; // 保持 tool_call 顺序
  let stopUnified = 'stop';
  for await (const part of gen) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    switch (part.type) {
      case 'text_delta':
        text += part.text;
        break;
      case 'tool_call_start':
        names.set(part.id, part.name);
        inputBuf.set(part.id, '');
        order.push(part.id);
        break;
      case 'tool_call_delta':
        inputBuf.set(part.id, (inputBuf.get(part.id) ?? '') + part.inputDelta);
        break;
      case 'tool_call_end':
        break; // 累积已随 delta 完成
      case 'usage':
        break; // usage 暂不用于事件（成本追踪 M5）
      case 'stop':
        stopUnified = part.reason.unified;
        break;
    }
  }
  const toolCalls = order.map((id) => ({
    id,
    name: names.get(id) ?? 'unknown',
    input: safeParseToolInput(inputBuf.get(id) ?? '{}'),
  }));
  return { text, toolCalls, stopUnified };
}

/** 健壮解析 tool_call 的 input JSON：失败时返回带 _parseError 的对象（不让单个坏 JSON 杀 loop）。 */
function safeParseToolInput(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _parseError: 'tool_call input 非法 JSON', _raw: s };
  }
}

/**
 * 事件化 agent loop。
 *
 * 用法：`for await (const event of runAgentStream(task, opts)) { ... }`
 * 消费方据 event.type 渲染（CLI 打印 / Ink UI / 测试断言）。
 *
 * 终止路径：
 *   - LLM 给出最终文本回答（无 tool_call）→ completed(reason: 'done')
 *   - 连续两轮工具签名重复 → completed(reason: 'repeated')
 *   - signal aborted → completed(reason: 'aborted')
 *   - MAX_ITERATIONS 跑满 → completed(reason: 'max-iterations')
 *   - 任意其它异常 → yield error（不 re-throw，消费方决定如何提示）
 */
export async function* runAgentStream(
  task: string,
  opts: RunAgentStreamOptions = {},
): AsyncGenerator<AgentEvent> {
  const resolvedModel = opts.model ?? getDefaultModel();
  const provider = opts.provider ?? createProvider(resolvedModel);
  const useTools = hasCapability(resolvedModel, 'tools');
  const allow = opts.allow ?? new AllowList();
  const system = opts.system ?? buildSystemPrompt();

  let messages: ECodeMessage[] = opts.resumed
    ? [...opts.resumed.messages, { role: 'user', content: task }]
    : [{ role: 'user', content: task }];

  const tools = useTools ? toolDefinitions : [];
  // runtime-log（CLAUDE.md §1.6：日志保存到文件供排查）—— 与原 runAgent 一致
  const logFile = initRuntimeLog(task, resolvedModel, provider.baseURL);
  // session 落盘上下文（与原 runAgent 一致：首轮/每轮末/压缩后/结束落盘）
  const sessionId = opts.resumed?.id ?? timestampId();
  const sessionTask = opts.resumed?.task ?? task;
  const createdAt = opts.resumed?.createdAt ?? new Date().toISOString();
  const stats: ECodeSessionStats = { rounds: 0, compressed: false, toolCalls: 0 };
  const buildSession = (): ECodeSession => ({
    id: sessionId,
    task: sessionTask,
    model: resolvedModel,
    messages,
    createdAt,
    updatedAt: new Date().toISOString(),
    stats: { ...stats },
  });

  persistSession(buildSession()); // 首次落盘（loop 前，与原 runAgent 一致）

  yield { type: 'start', task, model: resolvedModel, provider: provider.name, logFile };

  let lastSignature = '';
  let iteration: number;

  try {
    for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // ---- 上下文压缩（复用 maybeCompress；降级提示走事件）----
      const compressResult = await maybeCompress(messages, {
        model: resolvedModel,
        system,
        summarize: async (prompt: string) => {
          const resp = await provider.complete({
            model: resolvedModel,
            system: '你是对话历史压缩器。',
            messages: [{ role: 'user', content: prompt }],
            tools: [], // 压缩禁工具
          });
          return resp.content.find((b) => b.type === 'text')?.text ?? '';
        },
      });
      if (compressResult.compressed) {
        messages = compressResult.messages;
        stats.compressed = true;
        persistSession(buildSession()); // 压缩后立即落盘
        yield { type: 'warning', message: '上下文已压缩' };
      }

      // ---- 流式调用 LLM ----
      logApiRequest(iteration, messages, tools);
      const streamGen = provider.stream(
        { model: resolvedModel, system, messages, tools },
        { signal: opts.signal },
      );
      const { text, toolCalls } = await consumeStream(streamGen, opts.signal);
      stats.rounds = iteration + 1;

      // 构造本轮 assistant 完整回复 blocks（供日志 + push messages）
      const assistantBlocks: ECodeContentBlock[] = [];
      if (text) assistantBlocks.push({ type: 'text', text });
      for (const tc of toolCalls) {
        assistantBlocks.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      }
      // 流式下 usage 可能不完整（OpenAI 需 stream_options，Anthropic 在 message_delta）；先记 0，保时序
      logApiResponse(
        iteration,
        assistantBlocks,
        { unified: toolCalls.length > 0 ? 'tool-use' : 'stop' },
        { inputTokens: 0, outputTokens: 0 },
      );

      // ---- 有文本时 yield text_delta（无论是否有工具调用——保持事件流完整性） ----
      // 与原 runAgent 行为一致：text 始终流向输出（旧代码 process.stdout.write 无条件打印）。
      // 常见场景：LLM 先说"让我读取 package.json"再发 tool_call —— 这段文字也必须作为事件流出。
      if (text) yield { type: 'text_delta', text };

      // ---- 没有工具调用 → LLM 给出最终回答，终止 ----
      if (toolCalls.length === 0) {
        persistSession(buildSession()); // 最终落盘
        yield {
          type: 'completed',
          rounds: iteration + 1,
          toolCalls: stats.toolCalls,
          reason: 'done',
        };
        return;
      }

      // ---- push assistant 本轮完整回复（text + tool_call blocks）----
      messages.push({ role: 'assistant', content: assistantBlocks });

      // ---- 执行每个工具（含权限拦截）----
      for (const tc of toolCalls) {
        const def = toolDefinitions.find((t) => t.name === tc.name);
        const isDangerous = def?.dangerous ?? false;

        if (shouldAsk(tc.name, isDangerous, allow)) {
          // 可观测事件：UI 据此渲染"是否允许"对话框；决策本身走 permissionGate 回调
          yield {
            type: 'permission_request',
            toolUseId: tc.id,
            toolName: tc.name,
            input: tc.input,
          };
          if (opts.permissionGate) {
            const decision = await opts.permissionGate.ask({
              toolName: tc.name,
              input: tc.input,
            });
            if (decision === 'deny') {
              const denyMsg = `用户拒绝执行工具 ${tc.name}`;
              yield {
                type: 'tool_result',
                id: tc.id,
                name: tc.name,
                content: denyMsg,
                isError: true,
              };
              // 仍要 push tool_result 保配对（tool_use_id ↔ tool_use.id）
              messages.push({
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: tc.id,
                    output: { type: 'error', value: denyMsg },
                  },
                ],
              });
              continue; // 跳过 executeTool
            }
            allow.add(tc.name); // allow → 会话记住，后续同工具不再询问
          }
          // 无 gate = 默认放行（兼容无 UI / 测试）
        }

        yield { type: 'tool_call_start', id: tc.id, name: tc.name };

        // 防御：工具实现抛异常时降级为 isError 回喂 LLM（与原 runAgent 一致）
        let result: { content: string; isError: boolean };
        try {
          result = await executeTool(tc.name, tc.input);
        } catch (err) {
          result = {
            content: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }

        logToolExecution(iteration, tc.name, tc.input, result.content, result.isError);
        yield {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          content: result.content,
          isError: result.isError,
        };

        // 回传 tool_result（id 必须配对！）
        const output: ECodeToolResultOutput = result.isError
          ? { type: 'error', value: result.content }
          : { type: 'text', value: result.content };
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tc.id, output }],
        });
      }

      // ---- 重复动作检测（防死循环）：连续两轮工具签名相同 → 终止 ----
      const signature = toolCalls
        .map((t) => `${t.name}:${JSON.stringify(t.input)}`)
        .sort()
        .join(' || ');
      if (signature === lastSignature) {
        yield {
          type: 'warning',
          message: '检测到连续重复的工具调用，终止以防死循环',
        };
        persistSession(buildSession());
        yield {
          type: 'completed',
          rounds: iteration + 1,
          toolCalls: stats.toolCalls,
          reason: 'repeated',
        };
        return;
      }
      lastSignature = signature;

      // 每轮末落盘（与原 runAgent 一致）：跑到第 N 轮崩了，--continue 从第 N 轮续上
      stats.toolCalls += toolCalls.length;
      persistSession(buildSession());
    }

    // ---- 达 MAX_ITERATIONS → 终止 ----
    persistSession(buildSession());
    yield {
      type: 'completed',
      rounds: iteration,
      toolCalls: stats.toolCalls,
      reason: 'max-iterations',
    };
  } catch (err) {
    // 中断 / 其它异常：本实现里 tool_result 在工具执行后立即 push，
    // 中断多发生在 stream 迭代中（tool_use 尚未确认），故此处主要兜底：
    // 记录错误事件 + 落盘，不破坏既有配对历史。
    // （真正需要补配对的场景——工具执行中途被中断——留 M4 配合更完整的 abort 语义细化。）
    persistSession(buildSession());
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    if (aborted) {
      yield {
        type: 'completed',
        rounds: stats.rounds,
        toolCalls: stats.toolCalls,
        reason: 'aborted',
      };
      return;
    }
    logError(`runAgentStream (round ${stats.rounds})`, err);
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    finalizeRuntimeLog(stats.rounds);
  }
}

export async function runAgent(
  task: string,
  model?: string,
  opts?: RunAgentOptions,
): Promise<void> {
  const resolvedModel = model ?? getDefaultModel();
  const provider = createProvider(resolvedModel);
  const useTools = hasCapability(resolvedModel, 'tools');

  // 初始化运行时日志（实时写入 docs/logs/runtime/）
  const logFile = initRuntimeLog(task, resolvedModel, provider.baseURL);

  // 消息历史 —— 整个 agent 的"记忆"（ECode 内部格式，与协议无关）
  // 用 let：ContextManager 超阈值时会用压缩后的 messages 替换（数据结构不变）
  // 续接(--continue/--resume):前置恢复的历史,再追加本次新任务(决策③A)
  let messages: ECodeMessage[] = opts?.resumed
    ? [...opts.resumed.messages, { role: 'user', content: task }]
    : [{ role: 'user', content: task }];

  // ---- Session 持久化上下文(§6.3)----
  // 续接复用原 id/首句任务/创建时间(续写同一文件);新建则用启动时间戳。
  const sessionId = opts?.resumed?.id ?? timestampId();
  const sessionTask = opts?.resumed?.task ?? task;
  const createdAt = opts?.resumed?.createdAt ?? new Date().toISOString();
  const stats: ECodeSessionStats = { rounds: 0, compressed: false, toolCalls: 0 };

  /** 用当前 messages 快照构造 session(每次落盘调用,updatedAt 刷新到当下)。 */
  const buildSession = (): ECodeSession => ({
    id: sessionId,
    task: sessionTask,
    model: resolvedModel,
    messages,
    createdAt,
    updatedAt: new Date().toISOString(),
    stats: { ...stats },
  });

  persistSession(buildSession()); // 首次落盘(loop 前)

  const tools = useTools ? toolDefinitions : [];
  const system = buildSystemPrompt();

  // 压缩用的 summarize 注入：复用同一个 provider，但不带 tools（压缩时不调工具）
  const summarize = async (prompt: string): Promise<string> => {
    const resp = await provider.complete({
      model: resolvedModel,
      system: '你是对话历史压缩器。',
      messages: [{ role: 'user', content: prompt }],
      tools: [], // 压缩禁工具（天然不带 tools，无需 Claude Code 三重保险）
    });
    return resp.content.find((b) => b.type === 'text')?.text ?? '';
  };

  console.log(`\n🤖 ECode (model: ${resolvedModel}, provider: ${provider.name}, endpoint: ${provider.baseURL})`);
  console.log(`📝 任务: ${task}`);
  console.log(`📋 日志: ${logFile}\n`);

  let iteration: number;
  let lastSignature = '';
  let repeated = false;
  for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // ---- 上下文管理：每轮 API 调用前检查是否需要压缩 ----
    const compressResult = await maybeCompress(messages, {
      model: resolvedModel,
      system,
      summarize,
    });
    if (compressResult.compressed) {
      messages = compressResult.messages;
      stats.compressed = true;
      persistSession(buildSession()); // 压缩后立即落盘(反映压缩后态)
      console.log(`\n🗜️  上下文已压缩（第 ${iteration + 1} 轮）`);
    }

    // ---- 日志：API 请求 ----
    logApiRequest(iteration, messages, tools);

    // ---- 调用 LLM（经 Provider 抽象，带重试 + 超限响应式恢复）----
    // L3: API 报 context-window 错时,withRetry(400 不可重试)会抛 → 这里捕获,
    //     强制压缩(forceCompact)后用更小的 messages 重试一次。
    //     forceCompact 返回 null = 压不动(L4 熔断)→ 放弃,抛清晰错误,防死循环。
    let response: ECodeResponse;
    try {
      response = await withRetry(
        () =>
          provider.complete({
            model: resolvedModel,
            system,
            messages,
            tools,
          }),
        `provider:${resolvedModel}`,
      );
    } catch (err) {
      logError(`API call (round ${iteration})`, err);
      if (!isContextWindowError(err)) throw err;

      // 上下文超限 → 响应式恢复:强制压缩 + 重试一次
      console.log('\n🚨 上下文超出模型窗口,触发强制压缩...');
      const recovered = await forceCompact(messages, {
        model: resolvedModel,
        system,
        summarize,
      });
      if (!recovered) {
        throw new Error(
          '上下文超出模型窗口且无法进一步压缩(可能单个工具结果过大)。请缩短任务或清理历史后重试。',
        );
      }
      // 用压缩后的 messages 重试(此处必已低于阈值,重试应成功)
      messages = recovered;
      stats.compressed = true;
      persistSession(buildSession()); // 响应式恢复后立即落盘
      console.log('🗜️  强制压缩完成,重试中...');
      response = await withRetry(
        () =>
          provider.complete({
            model: resolvedModel,
            system,
            messages,
            tools,
          }),
        `provider:${resolvedModel}`,
      );
    }

    // ---- 日志：API 响应 ----
    logApiResponse(iteration, response.content, response.stopReason, response.usage);
    stats.rounds = iteration + 1; // 标记完成一轮 API 调用

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

      // 回传 tool_result —— id 必须配对！v2: output 判别联合
      const output: ECodeToolResultOutput = result.isError
        ? { type: 'error', value: result.content }
        : { type: 'text', value: result.content };
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            output,
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

    // 每轮末落盘(§6.3):跑到第 N 轮崩了,--continue 从第 N 轮续上
    stats.toolCalls += toolUseBlocks.length;
    persistSession(buildSession());
  }

  // 最终落盘(§6.3):无论正常/重复/达上限退出,都刷新最终态(updatedAt 最新)
  persistSession(buildSession());

  // 完成日志
  finalizeRuntimeLog(iteration + 1);

  // 终止原因：重复动作（loop 内已打印警告）/ 跑满上限 / 正常结束
  if (!repeated && iteration >= MAX_ITERATIONS) {
    console.log(`\n⚠️  达到最大迭代次数 (${MAX_ITERATIONS})，自动终止`);
  }
}
