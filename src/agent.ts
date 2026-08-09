import { randomUUID } from 'node:crypto';
import { toolDefinitions, executeTool } from './tools/index.js';
import { createTaskTool } from './tools/subagent.js';
import { loadAgents } from './subagent/loader.js';
import { buildAgentsCatalog } from './subagent/prompt.js';
import { createHookGate } from './hooks/inject.js';
import { getEffectiveHooks } from './hooks/system-hooks.js';
import type { HookDef } from './hooks/types.js';
import type { HookGate } from './hooks/inject.js';
import type { ShellExec } from './hooks/runner.js';
import type { ToolDefinition } from './tools/types.js';
import { validateAfterEdit } from './tools/validation.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createProvider } from './providers/factory.js';
import { getDefaultModel, hasCapability } from './providers/config.js';
import type {
  ECodeMessage,
  ECodeToolResultOutput,
  ModelProvider,
  ECodeStreamPart,
  ECodeContentBlock,
  ECodeUsage,
} from './providers/types.js';
import { maybeCompress, forceCompact, isContextWindowError } from './context-manager.js';
import type { CompressOptions } from './context-manager.js';
import {
  initRuntimeLog,
  logApiRequest,
  logApiResponse,
  logToolExecution,
  logError,
  logSessionSave,
  finalizeRuntimeLog,
} from './runtime-logger.js';
import { saveSession } from './session.js';
import type { ECodeSession, ECodeSessionStats } from './session.js';
import type { AgentEvent } from './agent-events.js';
import { assertNever } from './assert-never.js';
import { AllowList } from './permission.js';
import type { PermissionGate } from './permission.js';
import { check } from './permission/rule-engine.js';
import { splitCompound, toAlwaysPattern } from './permission/arity.js';
import { DoomLoopDetector, isDoomLoop } from './permission/doom-loop.js';
import type { PermissionMode, Rule, GateDecision } from './permission/types.js';

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

/**
 * 生成 session id：使用 crypto.randomUUID()（UUID v4）。
 *
 * 为什么不用时间戳 YYYYMMDDHHmmss：
 *   旧方案秒级精度，同秒内连续运行两次不同任务会产生相同 ID，
 *   因 slug(task) 不同导致 saveSession 写出两个文件——覆盖机制失效，
 *   loadSession 只能找到第一个匹配项（readdirSync.find 随机），数据静默丢失。
 *   参考：Claude Code 用 UUID，OpenCode 用 ses_+UUID。
 *
 * UUID v4 碰撞概率：需生成 ~2.71×10^18 个才有 50% 碰撞——单用户 CLI 不可能达到。
 */
function generateSessionId(): string {
  return randomUUID();
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
    const path = saveSession(session);
    logSessionSave(path, session.id, session.task, session.messages.length, session.stats.rounds);
  } catch (err) {
    if (!sessionSaveFailed) {
      sessionSaveFailed = true;
      console.warn(
        `⚠️  会话未持久化,本次不可 --continue:${err instanceof Error ? err.message : String(err)}`,
      );
      logError('Session 落盘失败(首次)', err);
    } else {
      logError('Session 落盘失败(静默重试)', err);
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
  permissionMode?: PermissionMode; // 权限档（default/acceptEdits/bypass，默认 default）
  /** 权限档动态读取（支持 REPL Shift+Tab 运行中切换即时生效）。
   *  优先于 permissionMode 值；agent 每次工具 check 时调用，而非 runAgentStream 启动时绑定一次。
   *  不传 → 回退 permissionMode 值（向后兼容现有测试 / 非 UI 调用）。 */
  getPermissionMode?: () => PermissionMode;
  /** settings.json 配置的 deny 规则（阶段 4：user+project 两层合并，启动时加载一次）。 */
  denyRules?: Rule[];
  provider?: ModelProvider; // 依赖注入（测试用 mock；生产用 createProvider）
  /** 工具集覆盖（默认 toolDefinitions）。子代理限定子集、MCP 注入第三方工具用。
   *  不传 = 用内置 toolDefinitions（现有行为不变，零回归）。阶段 0 地基。 */
  tools?: ToolDefinition[];
  /** 子代理嵌套深度（主代理 = 0；Task 工具递归子代理时 +1）。防递归爆炸，默认 0。阶段 1。 */
  subagentDepth?: number;
  /**
   * Hooks（支点 12）：用户/项目配置的 hook 列表。系统 hook（SYSTEM_HOOKS）恒前置叠加，不可移除。
   * 不传 / 有效集为空 → 不注入 gate，核心循环字节级不变（零回归）。阶段 2。
   * 配置加载（settings.json hooks 字段）后置审阅；一期经此字段注入可测。
   */
  hooks?: HookDef[];
  /**
   * hook 执行器注入（同 opts.provider/tools 的注入模式）：测试用 mock exec 免真 spawn；
   * 生产留作自定义执行器（沙箱 / dry-run）的接入口。不传 → runner 默认 spawn。
   */
  hooksExec?: ShellExec;
}

/** consumeStream 的累积结果：逐 chunk yield 完 text_delta 后 return，供本轮 push messages / 日志用。 */
interface ConsumedStream {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopUnified: string;
  usage: ECodeUsage;
}

/**
 * 流式消费 provider chunk（M3.5 R4：逐 chunk yield，而非整轮累加后一次性输出）。
 * - text_delta → 逐 chunk yield（UI 动态区真正流式），同时累积进 text
 * - tool_call_start/delta/end → 按 id 跨 chunk 累积 input JSON（不 yield，本轮后续统一处理）
 * - usage → 记录本轮 token 用量（供 runAgentStream yield usage 事件，UI 累计）
 * - stop → 记录 unified 停止原因
 * 返回值 = 累积结果（text 全文 + toolCalls + usage + stopUnified）。
 * 中断：迭代中 signal.aborted → 抛 AbortError（DOMException）让外层 catch 收尾。
 *
 * 设计：用 async generator 同时 yield（流式事件）+ return（累积结果），
 * 调用方用 drain 循环转发 yield 并捕获 return（见 runAgentStream 内 consumeStream 调用处）。
 */
async function* consumeStream(
  gen: AsyncIterable<ECodeStreamPart>,
  signal?: AbortSignal,
): AsyncGenerator<{ type: 'text_delta'; text: string }, ConsumedStream, void> {
  let text = '';
  const inputBuf = new Map<string, string>(); // id → 累积的 input JSON 字符串
  const names = new Map<string, string>(); // id → name
  const order: string[] = []; // 保持 tool_call 顺序
  let stopUnified = 'stop';
  let usage: ECodeUsage = { inputTokens: 0, outputTokens: 0 };
  for await (const part of gen) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    switch (part.type) {
      case 'text_delta':
        text += part.text;
        yield { type: 'text_delta', text: part.text }; // 逐 chunk 流出（R4）
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
        usage = {
          inputTokens: part.inputTokens,
          outputTokens: part.outputTokens,
          ...(part.cacheReadTokens != null && { cacheReadTokens: part.cacheReadTokens }),
          ...(part.cacheWriteTokens != null && { cacheWriteTokens: part.cacheWriteTokens }),
          ...(part.reasoningTokens != null && { reasoningTokens: part.reasoningTokens }),
        };
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
 * 手动触发上下文压缩（/compact 命令用，D2）。
 * 不走 agent loop——UI 层直接调:内部 createProvider + 构造 summarize + forceCompact。
 * 与 runAgentStream 内部的 compressOpts.summarize 同构（压缩器 system + 禁工具 + 取首个 text block），
 * 不复用 runAgentStream 的闭包变量（保持其稳定，§1.7 不重构周边）。
 * @returns 压缩后的 messages；null = 熔断（压到极限仍超限）或空 messages
 */
export async function compactMessages(
  messages: ECodeMessage[],
  opts: { model: string; system: string },
): Promise<ECodeMessage[] | null> {
  if (messages.length === 0) return messages;
  const provider = createProvider(opts.model);
  const summarize = async (prompt: string): Promise<string> => {
    const resp = await provider.complete({
      model: opts.model,
      system: '你是对话历史压缩器。',
      messages: [{ role: 'user', content: prompt }],
      tools: [], // 压缩禁工具
    });
    return resp.content.find((b) => b.type === 'text')?.text ?? '';
  };
  return forceCompact(messages, { model: opts.model, system: opts.system, summarize });
}

/**
 * 事件化 agent loop。
 *
 * 用法：`for await (const event of runAgentStream(task, opts)) { ... }`
 * 消费方据 event.type 渲染（CLI 打印 / Ink UI / 测试断言）。
 *
 * 终止路径：
 *   - LLM 给出最终文本回答（无 tool_call）→ completed(reason: 'done')
 *   - 连续两轮工具签名重复 且无 permissionGate（非交互）→ completed(reason: 'repeated')
 *     （交互模式由 doom_loop 在阈值 3 时弹窗询问用户 continue/abort，不在此硬终止）
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
  // doom_loop 检测器（阶段5d）：跨轮持久，连续同 (tool,input) ≥3 触发，强制询问打破死循环。
  const doom = new DoomLoopDetector();
  // 权限档动态读取（支点：REPL Shift+Tab 运行中切换即时生效）：每次工具 check / Task 派发时调用，
  // 而非 runAgentStream 启动时绑定一次。getPermissionMode 优先（UI 传 ref.current），回退 permissionMode 值。
  const resolveMode = (): PermissionMode => opts.getPermissionMode?.() ?? opts.permissionMode ?? 'default';
  const baseSystem = opts.system ?? buildSystemPrompt();
  // 阶段 1：把可派遣子代理 catalog 注入主 system（懒加载：只 name+description，不暴露人设正文）。
  //   无 .ecode/agents → catalog 空 → system 不变（零影响）。主 LLM 据此决定派哪个具名人设。
  const agentsCatalog = buildAgentsCatalog(loadAgents());
  const system = agentsCatalog ? `${baseSystem}\n\n---\n\n${agentsCatalog}` : baseSystem;

  let messages: ECodeMessage[] = opts.resumed
    ? [...opts.resumed.messages, { role: 'user', content: task }]
    : [{ role: 'user', content: task }];

  // 阶段 1：动态注入 Task 工具（闭包捕获本 runAgentStream 的权限上下文 + 深度）。
  //   Task 不静态注册——静态 import 拿不到运行时 opts（allow/mode/gate/provider）。
  //   闭包天然实现权限⊆（继承全部 + 人设 tools 收紧）+ 防递归（subagentDepth 累加，超限拒派）。
  const baseTools = useTools ? opts.tools ?? toolDefinitions : [];
  const tools = useTools
    ? [
        ...baseTools.filter((t) => t.name !== 'Task'),
        createTaskTool({
          // 子代理继承主 system（含 CLAUDE.md）但不含 agents catalog——它派不了子代理（深度限制），
          // 看到 catalog 反而诱导它白调 Task（被拒、浪费一轮）。
          system: baseSystem,
          allow,
          getPermissionMode: resolveMode,
          denyRules: opts.denyRules,
          gate: opts.permissionGate,
          provider,
          model: resolvedModel,
          depth: opts.subagentDepth ?? 0,
        }),
      ]
    : [];

  // 阶段 2：构建 hook gate（Pre/Post 决策聚合）。系统 hook 恒前置叠加不可移除。
  //   有效集为空 → hookGate=undefined，循环内各注入点用 `if (hookGate)` 守卫，字节级零回归。
  const effectiveHooks = getEffectiveHooks(opts.hooks ?? []);
  const hookGate: HookGate | undefined =
    effectiveHooks.length > 0 ? createHookGate(effectiveHooks, { exec: opts.hooksExec }) : undefined;

  // runtime-log（CLAUDE.md §1.6：日志保存到文件供排查）—— 与原 runAgent 一致
  const logFile = initRuntimeLog(task, resolvedModel, provider.baseURL);
  // session 落盘上下文（与原 runAgent 一致：首轮/每轮末/压缩后/结束落盘）
  const sessionId = opts.resumed?.id ?? generateSessionId();
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

  // 压缩选项（maybeCompress + forceCompact 共用，提取到循环外避免重复构造）
  const compressOpts: CompressOptions = {
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
  };
  // L3 重试计数：连续 context window 超限次数，超过上限则 L4 熔断（防死循环）
  let consecutiveContextErrors = 0;
  const MAX_CONTEXT_RETRIES = 3;

  try {
    for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // ---- 上下文压缩（proactive maybeCompress；降级提示走事件）----
      const compressResult = await maybeCompress(messages, compressOpts);
      if (compressResult.compressed) {
        messages = compressResult.messages;
        stats.compressed = true;
        persistSession(buildSession()); // 压缩后立即落盘
        yield { type: 'warning', message: '上下文已压缩' };
      }

      // ---- 流式调用 LLM ----
      let consumed!: ConsumedStream;
      try {
        logApiRequest(iteration, messages, tools);
        const streamGen = provider.stream(
          { model: resolvedModel, system, messages, tools },
          { signal: opts.signal },
        );
        // 流式消费（M3.5 R4）：逐 chunk yield text_delta——UI 动态区真正流式，
        // 而非旧实现"整轮累加后一次性输出"。drain 循环转发每个 text_delta 事件，
        // 消费结束捕获累积结果。时序保持：text（消费期间）→ usage（消费后）→ tool（执行）。
        const consumer = consumeStream(streamGen, opts.signal);
        while (true) {
          const { value, done } = await consumer.next();
          if (done) {
            consumed = value;
            break;
          }
          yield value; // 转发逐 chunk text_delta 事件
        }
      } catch (apiErr) {
        // L3 响应式恢复：context window 超限 → forceCompact 压缩 → 重试
        if (isContextWindowError(apiErr)) {
          consecutiveContextErrors++;
          if (consecutiveContextErrors > MAX_CONTEXT_RETRIES) {
            // L4 熔断：连续超限次数过多，放弃恢复
            yield { type: 'error', error: `上下文超限，连续 ${MAX_CONTEXT_RETRIES} 次压缩后仍超限，终止` };
            persistSession(buildSession());
            return;
          }
          const compressed = await forceCompact(messages, compressOpts);
          if (compressed) {
            messages = compressed;
            persistSession(buildSession());
            yield { type: 'warning', message: `上下文超限，已强制压缩并重试（第 ${consecutiveContextErrors} 次）` };
            continue; // 用压缩后的 messages 重试本轮
          }
          // L4 熔断：forceCompact 返回 null（压到极限仍超限）
          yield { type: 'error', error: '上下文超限且压缩到极限仍超限，终止' };
          persistSession(buildSession());
          return;
        }
        throw apiErr; // 非 context window 错误 → 传播到外层 catch
      }
      consecutiveContextErrors = 0; // API 调用成功，重置连续超限计数
      const { text, toolCalls, usage } = consumed;
      stats.rounds = iteration + 1;

      // 构造本轮 assistant 完整回复 blocks（供日志 + push messages）
      const assistantBlocks: ECodeContentBlock[] = [];
      if (text) assistantBlocks.push({ type: 'text', text });
      for (const tc of toolCalls) {
        assistantBlocks.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      }
      // 日志记录本轮真实 usage（consumeStream 已在流结束捕获完整用量，含 cache/reasoning）
      logApiResponse(
        iteration,
        assistantBlocks,
        { unified: toolCalls.length > 0 ? 'tool-use' : 'stop' },
        usage,
      );

      // ---- 本轮 usage 事件（状态栏累计 token/费用用；每轮各 yield 一个，透传五项）----
      yield { type: 'usage', ...usage };

      // ---- push assistant 本轮完整回复（必须在 done 判断之前！）----
      // 否则纯文本最终回答进不了 messages：done 路径在 push 之前 return，
      // 会导致 REPL 多轮续接 / --continue 时 LLM 看不到自己上一轮的回答
      // （messages 缺最后一条 assistant）。三方参考（CCode HistoryWriter 原地写、
      // Claude Code 无状态 query 每轮喂完整历史）均是每轮 assistant 无条件入历史。
      if (assistantBlocks.length > 0) {
        messages.push({ role: 'assistant', content: assistantBlocks });
      }

      // ---- 没有工具调用 → LLM 给出最终回答，终止 ----
      if (toolCalls.length === 0) {
        persistSession(buildSession()); // 最终落盘
        yield {
          type: 'completed',
          rounds: iteration + 1,
          toolCalls: stats.toolCalls,
          reason: 'done',
          sessionId,
          messages,
          task: sessionTask,
          createdAt,
        };
        return;
      }

      // ---- 执行每个工具（含权限拦截）----
      for (const tc of toolCalls) {
        const def = tools.find((t) => t.name === tc.name);
        const isDangerous = def?.dangerous ?? false;

        // ---- PreToolUse hook（支点 12）：可拦 / 可改输入，收紧优先（deny 即终态，等同权限拒绝）。
        //   hookGate 仅在有有效 hook 时存在 → 无 hook 时 effectiveInput 恒等于 tc.input，核心循环字节级不变。
        //   modifiedInput → 整体替换工具输入（后续 check/doom/gate/execute 全走改后输入）；
        //   deny → 回喂 LLM 并 continue（与权限 deny 路径同构，保 tool_use_id 配对不断裂）。
        let effectiveInput: Record<string, unknown> = tc.input;
        if (hookGate) {
          const pre = await hookGate.preToolUse(tc.name, tc.input);
          if (pre.decision === 'deny') {
            const hookDenied = `hook 拒绝执行工具 ${tc.name}${pre.reason ? `：${pre.reason}` : ''}`;
            yield {
              type: 'tool_result',
              id: tc.id,
              name: tc.name,
              content: hookDenied,
              isError: true,
            };
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  output: { type: 'error', value: hookDenied },
                },
              ],
            });
            continue;
          }
          if (pre.modifiedInput) effectiveInput = pre.modifiedInput;
        }

        const verdict = check({
          toolName: tc.name,
          input: effectiveInput,
          isDangerous,
          mode: resolveMode(),
          allow,
          roots: [process.cwd()],
          denyRules: opts.denyRules,
        });

        // doom_loop（阶段5d）：连续同 (tool,input) 达阈值即嫌疑死循环。
        // 即便 check 放行也升级为 ask（交还用户决策），但 deny 策略更强，仍按 deny 走。
        const repeatCount = doom.observe(tc.name, effectiveInput);
        const doomTriggered = isDoomLoop(repeatCount);
        const forceAsk = doomTriggered && verdict.action !== 'deny';

        // 拒绝原因（策略 deny 或用户 deny）；非 null 则回喂 LLM 并跳过执行
        let denied: string | null = null;
        if (verdict.action === 'deny') {
          denied = `权限策略拒绝执行工具 ${tc.name}：${verdict.reason}`;
        } else if (verdict.action === 'ask' || forceAsk) {
          if (doomTriggered) {
            yield {
              type: 'warning',
              message: `检测到连续 ${repeatCount} 次相同调用 ${tc.name}，疑似死循环`,
            };
          }
          // 可观测事件：UI 据此渲染"是否允许"对话框；决策本身走 permissionGate 回调
          yield {
            type: 'permission_request',
            toolUseId: tc.id,
            toolName: tc.name,
            input: effectiveInput,
            reason: doomTriggered
              ? `疑似死循环（连续 ${repeatCount} 次相同调用），确认继续？`
              : undefined,
          };
          if (opts.permissionGate) {
            // 阶段5b：gate 结果可能是纯 GateDecision（无反馈，向后兼容）或
            // { decision, feedback? }（deny 携带用户反馈）。归一两种形式。
            const raw = await opts.permissionGate.ask({
              toolName: tc.name,
              input: effectiveInput,
            });
            const decision: GateDecision = typeof raw === 'string' ? raw : raw.decision;
            const feedback = typeof raw === 'string' ? undefined : raw.feedback;
            if (decision === 'deny') {
              denied = `用户拒绝执行工具 ${tc.name}${feedback ? `，反馈：${feedback}` : ''}`;
            } else if (decision === 'allow_always') {
              // 🔴-2 修复：仅 allow_always 记会话规则；allow_once 不记，下次仍询问。
              // 阶段 3：bash 按命令粒度记 pattern（防整工具放行过宽，'git checkout' 不该放行 'git push'）；
              //   逐 compound 段生成 pattern 入库（仿 opencode per-node）。
              //   非 bash 仍工具名粒度（阶段 2 语义不变）。
              if (tc.name === 'bash') {
                const command = String(effectiveInput.command ?? '');
                for (const seg of splitCompound(command)) {
                  allow.addBashPattern(toAlwaysPattern(seg));
                }
              } else {
                allow.add(tc.name);
              }
            }
          }
          // 无 gate = 默认放行（兼容无 UI / 测试）
        }

        if (denied) {
          yield {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            content: denied,
            isError: true,
          };
          // 仍要 push tool_result 保配对（tool_use_id ↔ tool_use.id）
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: tc.id,
                output: { type: 'error', value: denied },
              },
            ],
          });
          continue; // 跳过 executeTool
        }

        yield { type: 'tool_call_start', id: tc.id, name: tc.name, input: effectiveInput };

        // 防御：工具实现抛异常时降级为 isError 回喂 LLM（与原 runAgent 一致）
        let result: { content: string; isError: boolean };
        try {
          result = await executeTool(tc.name, effectiveInput, tools);
        } catch (err) {
          result = {
            content: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }

        // P0-5 后置验证：edit_file/write_file 成功后跑 build/test，失败回喂 LLM（降级不杀 agent）。
        // projectRoot 用 process.cwd()（CLI 启动目录=项目根；工具 input 无 cwd 字段）。
        if (!result.isError) {
          const vfail = await validateAfterEdit(tc.name, process.cwd());
          if (vfail) {
            result = {
              content: `文件已修改，但后置验证失败（${vfail.command}，${vfail.duration}ms）：\n${vfail.output}\n请根据上述输出修复。`,
              isError: true,
            };
          }
        }

        // ---- PostToolUse hook（支点 12）：工具已执行不可撤销——deny 仅把 reason 回喂 LLM。
        //   无 hookGate / hook 放行 → result 不变，零回归。isError 保持（工具确已跑），只追加反馈文本。
        if (hookGate) {
          const post = await hookGate.postToolUse(tc.name, effectiveInput, result.content);
          if (post.decision === 'deny') {
            result = {
              content: `${result.content}\n\n[PostToolUse hook 反馈] ${post.reason ?? '操作被 hook 标记'}`,
              isError: result.isError,
            };
          }
        }

        logToolExecution(iteration, tc.name, effectiveInput, result.content, result.isError);
        yield {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          content: result.content,
          isError: result.isError,
          input: effectiveInput,
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
      // 仅非交互模式（无 permissionGate）硬终止：交互模式下重复由 doom_loop（阈值 3）
      // 弹窗询问用户 continue/abort 接管，避免在用户可决策时过早硬断。
      const signature = toolCalls
        .map((t) => `${t.name}:${JSON.stringify(t.input)}`)
        .sort()
        .join(' || ');
      if (!opts.permissionGate && signature === lastSignature) {
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
          sessionId,
          messages,
          task: sessionTask,
          createdAt,
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
      sessionId,
      messages,
      task: sessionTask,
      createdAt,
    };
  } catch (err) {
    // 中断 / 其它异常：本实现里 tool_result 在工具执行后立即 push，
    // 中断多发生在 stream 迭代中（tool_use 尚未确认），故此处主要兜底：
    // 记录错误事件 + 落盘，不破坏既有配对历史。
    // （真正需要补配对的场景——工具执行中途被中断——留 M4 配合更完整的 abort 语义细化。）
    persistSession(buildSession());
    // 中断识别（放宽，修「中断后显示 ✗ Request was aborted」）：
    // openai SDK 在 fetch 被 abort 时抛的错误【不是】DOMException（message 形如
    // "Request was aborted" / "The user aborted a request"），旧的 instanceof DOMException
    // 判断会漏掉 → 被当真错误 yield {type:'error'} → UI 显示 ✗ Request was aborted
    // （与 app.tsx 的「— 已中断 —」warning 重复且为英文）。改用 signal.aborted 优先判断
    // （最可靠：不管 SDK 把错误包装成什么类型/message，只要 signal 已 abort 就是中断），
    // 再兜底 name/message 含 abort（无 signal 场景，如测试直接抛 AbortError）。
    const isAbortError = (e: unknown): boolean =>
      e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
    const aborted = opts.signal?.aborted || isAbortError(err);
    if (aborted) {
      yield {
        type: 'completed',
        rounds: stats.rounds,
        toolCalls: stats.toolCalls,
        reason: 'aborted',
        sessionId,
        messages,
        task: sessionTask,
        createdAt,
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
