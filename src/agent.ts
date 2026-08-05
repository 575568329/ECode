import { toolDefinitions, executeTool } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createProvider } from './providers/factory.js';
import { getDefaultModel, hasCapability } from './providers/config.js';
import type {
  ECodeMessage,
  ECodeToolResultOutput,
  ModelProvider,
  ECodeStreamPart,
  ECodeContentBlock,
} from './providers/types.js';
import { maybeCompress } from './context-manager.js';
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
import { assertNever } from './assert-never.js';
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
 * 把流式 chunk 累积成本轮响应内容（text + tool_call 完整 input + usage）。
 * - text_delta → 追加 text
 * - tool_call_start/delta/end → 按 id 累积 input JSON，跨 chunk 拼接
 * - usage → 记录本轮 token 用量（供 runAgentStream yield usage 事件，UI 累计）
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
  usage: { inputTokens: number; outputTokens: number };
}> {
  let text = '';
  const inputBuf = new Map<string, string>(); // id → 累积的 input JSON 字符串
  const names = new Map<string, string>(); // id → name
  const order: string[] = []; // 保持 tool_call 顺序
  let stopUnified = 'stop';
  let usage = { inputTokens: 0, outputTokens: 0 };
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
        usage = { inputTokens: part.inputTokens, outputTokens: part.outputTokens };
        break;
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
  return { text, toolCalls, stopUnified, usage };
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
      const { text, toolCalls, usage } = await consumeStream(streamGen, opts.signal);
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

      // ---- 本轮 usage 事件（状态栏累计 token/费用用；每轮各 yield 一个）----
      yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };

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
  opts?: RunAgentStreamOptions,
): Promise<void> {
  for await (const event of runAgentStream(task, { ...(opts ?? {}), model })) {
    switch (event.type) {
      case 'start':
        console.log(`\n🤖 ECode (model: ${event.model}, provider: ${event.provider})`);
        console.log(`📝 任务: ${event.task}`);
        if (event.logFile) console.log(`📋 日志: ${event.logFile}\n`);
        break;
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_call_start':
        console.log(`\n\n⚡ [${event.name}]`);
        break;
      case 'tool_result':
        if (event.isError) {
          console.log(`❌ 错误: ${event.content.slice(0, 300)}`);
        } else {
          console.log(`✅ 完成 (${event.content.length} 字符)`);
        }
        break;
      case 'warning':
        console.log(`\n⚠️  ${event.message}`);
        break;
      case 'completed':
        if (event.reason === 'max-iterations') {
          console.log(`\n⚠️  达到最大迭代次数 (${MAX_ITERATIONS})，自动终止`);
        }
        break;
      case 'usage':
        // 旧 CLI 不显示 token（状态栏在 REPL 里显示），静默吸收。
        break;
      case 'permission_request':
        console.log(`\n🔒 权限请求: ${event.toolName}（旧 CLI 自动放行，REPL 模式将弹窗）`);
        break;
      case 'error':
        console.error(`\n💥 ${event.error}`);
        break;
      default:
        assertNever(event);
    }
  }
}
