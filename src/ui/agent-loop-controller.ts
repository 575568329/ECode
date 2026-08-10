// 对话调度核心（消息队列与交互重做方案 §3）：单 runLoop + pendingQueue + busyRef 状态机。
//
// 为什么抽出独立类（非 React）：
//   - pendingQueue / messagesRef / busyRef / compact 互斥是纯调度逻辑，脱离 React 可独立单测（快）；
//   - hook（use-agent-stream）只做 controller ↔ React state 桥接
//     （onEvent→reducer、onQueueChange→setState 等）。
//
// 关键不变量：
//   - messagesRef（LLM history 真相源）只由 agent completed 全量回填（含 aborted 中断前 partial，不丢历史）；
//   - pendingQueue 是唯一"待处理"载体——不用 messagesRef 结构推断"末尾 user 即未响应"，
//     避免中断/出错期间用户又提交时的顺序冲突死锁（§3.1）；
//   - busyRef 互斥 running/compacting/idle，保证 runLoop 与 doCompact 不交错（§3.6 解并发竞态）。
//
// agent.ts 契约兼容：每轮 runAgent(text, { resumed:{ messages: messagesRef } })，agent 一行不改。

import type { AgentEvent } from '../agent-events.js';
import type { ECodeMessage, ImageSource } from '../providers/types.js';
import type { ResumeContext, RunAgentStreamOptions } from '../agent.js';

/** 调度状态机：idle（空闲）/ running（runLoop 处理队列）/ compacting（压缩中）。三者互斥。 */
export type BusyState = 'idle' | 'running' | 'compacting';

type CompletedEvent = Extract<AgentEvent, { type: 'completed' }>;

/** controller → hook 回调（React 桥）。hook 据此 setState / 调 reducer。 */
export interface ControllerCallbacks {
  /** 转发 AgentEvent → hook 调 reduceAgentEvent（streaming / tools / permission / completed→UI）。 */
  onEvent: (event: AgentEvent) => void;
  /** 待处理队列变化 → hook 同步 queuedMessages + pendingCount（排队灰显预览 + StatusBar 计数）。 */
  onQueueChange: (queue: readonly string[]) => void;
  // 注：onQueueChange 仍传 string[]（排队预览只显示文本，不显示图片缩略图）
  /** 出队一条 user → hook 落正式 user 气泡（避免与 queuedMessages 双显，§4.2）。images 可选（多模态）。 */
  onUserTurn: (text: string, images?: ImageSource[]) => void;
  /** busy 状态变化 → hook 设 isRunning/isCompacting（整体忙碌，不随单轮 start/completed 抖动）。 */
  onBusyChange: (busy: BusyState) => void;
  /** messages 真相源被替换（compact 后）→ hook 用新 messages 重灌 completedMessages + staticKey++。 */
  onMessagesReset: (messages: ECodeMessage[]) => void;
  /** 中断且本轮 LLM 未回应（情况 A，turnResponded=false）：撤回——不回填 messagesRef 的孤立 user，
   *  hook 据此移除刚落的 user 气泡 + 回填输入框（onTurnReverted prop 透传 App）。不显示中断标记。 */
  onTurnReverted?: (text: string, images?: ImageSource[]) => void;
  /** 中断但本轮 LLM 已回应（情况 B，turnResponded=true）：messagesRef 正常回填（含 user+partial），
   *  hook 据此显示「— 已中断 —」（替代旧 app.tsx 同步 addMessage——同步瞬间无法区分 A/B）。 */
  onTurnAborted?: () => void;
}

export interface ControllerDeps {
  /** 注入 runAgentStream（测试 mock；生产传真实 runAgentStream）。 */
  runAgent: (text: string, opts: RunAgentStreamOptions) => AsyncGenerator<AgentEvent>;
  /** 注入 compactMessages（测试 mock；生产传真实）。 */
  compactMessages: (
    messages: ECodeMessage[],
    opts: { model: string; system: string },
  ) => Promise<ECodeMessage[] | null>;
  /** 每轮 runAgent 的固定 opts（model/system/allow/permissionGate）；signal/resumed 由 controller 注入。
   *  getter 形式：model 可被 /model 切换，每次取最新值。 */
  getRunOpts: () => Omit<RunAgentStreamOptions, 'signal' | 'resumed'>;
  /** 压缩用 model/system（getter，model 可变）。 */
  getCompactOpts: () => { model: string; system: string };
  callbacks: ControllerCallbacks;
}

/**
 * 对话调度控制器。无 React 依赖，状态自持。
 * 生命周期：hook 创建一次（useRef 持守），整个会话复用；clear/resetSession 只重置内部 refs 不重建实例。
 */
export class AgentLoopController {
  private pendingQueue: { text: string; images?: ImageSource[] }[] = [];
  private messagesRef: ECodeMessage[] = [];
  private sessionRef: { id: string; task: string; createdAt: string } | null = null;
  private busyRef: BusyState = 'idle';
  private abortRef: AbortController | null = null;
  private compactQueued = false;
  /** 本轮 LLM 是否已回应（收到 text_delta/tool_call_start 即 true）。每轮 shift 后重置。
   *  中断分情况依据：aborted + 未回应 → 撤回（情况 A）；aborted + 已回应 → 显示中断（情况 B）。 */
  private turnResponded = false;
  /** clear/resetSession 序号：runLoop 回填前检测，若期间被重置则丢弃回填（避免"复活"已清历史）。 */
  private epoch = 0;

  constructor(private readonly deps: ControllerDeps) {}

  get busy(): BusyState {
    return this.busyRef;
  }

  /** 入队一条 user 文本（可选附带图片）；若空闲则启动 runLoop，忙时只入队（runLoop 自行 drain）。 */
  submit(text: string, images?: ImageSource[]): void {
    this.pendingQueue.push({ text, images });
    this.deps.callbacks.onQueueChange([...this.pendingQueue.map((item) => item.text)]);
    this.ensureRunLoop();
  }

  /** 中断当前轮（Ctrl+C）。runLoop 继续 drain queue（§3.5，非抢占式插话）。 */
  abort(): void {
    this.abortRef?.abort();
  }

  /**
   * 手动压缩（/compact）。idle 时立即执行；忙时排队（runLoop/压缩结束后执行）。
   * @returns before/after；null = 无消息可压 / 熔断 / 已排队（排队时结果异步送达，无同步返回）。
   */
  async compact(): Promise<{ before: number; after: number } | null> {
    // 忙时优先排队（不能被"messagesRef 暂空"误拦：A 跑期间 messagesRef 尚未回填，
    // 但 compact 应等 A 完成后压 A 的历史，而非直接判空返回）。
    if (this.busyRef !== 'idle') {
      this.compactQueued = true;
      return null; // 排队：runLoop finally 检测 compactQueued 后调 doCompact
    }
    return this.doCompact(); // idle：doCompact 内部检查 messagesRef 空 → 返回 null
  }

  /** /clear：重置真相源 + 清队列（UI 清空由 hook 处理）。 */
  clear(): void {
    this.epoch++;
    this.abortRef?.abort();
    this.compactQueued = false;
    this.sessionRef = null;
    this.messagesRef = [];
    this.pendingQueue = [];
    this.deps.callbacks.onQueueChange([]);
  }

  /** /resume：载入会话真相源（UI 历史还原由 hook 处理）。 */
  resetSession(resume: ResumeContext): void {
    this.epoch++;
    this.abortRef?.abort();
    this.compactQueued = false;
    this.sessionRef = { id: resume.id, task: resume.task, createdAt: resume.createdAt };
    this.messagesRef = [...resume.messages];
    this.pendingQueue = [];
    this.deps.callbacks.onQueueChange([]);
  }

  currentSessionId(): string | null {
    return this.sessionRef?.id ?? null;
  }

  // ---- 内部 ----

  /** 启动 runLoop（仅当空闲且有待处理）。busy 时 no-op（runLoop/doCompact 自行 drain）。 */
  private ensureRunLoop(): void {
    if (this.busyRef !== 'idle') return;
    if (this.pendingQueue.length === 0) return; // 无待处理不空转（避免 busy 状态无谓抖动）
    this.busyRef = 'running';
    this.deps.callbacks.onBusyChange('running');
    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.pendingQueue.length > 0) {
        const turnEpoch = this.epoch;
        const item = this.pendingQueue.shift()!;
        this.turnResponded = false; // 本轮 LLM 回应标志重置（中断分情况依据）
        // 该 user 从"排队"转"正式"：队列变短 + 落正式气泡（不与 queuedMessages 双显）
        this.deps.callbacks.onQueueChange([...this.pendingQueue.map((i) => i.text)]);
        this.deps.callbacks.onUserTurn(item.text, item.images);

        const controller = new AbortController();
        this.abortRef = controller;
        let completedEvent: CompletedEvent | null = null;
        try {
          const base = this.deps.getRunOpts();
          const resumed: ResumeContext | undefined = this.sessionRef
            ? { ...this.sessionRef, messages: this.messagesRef }
            : undefined;
          for await (const event of this.deps.runAgent(item.text, {
            ...base,
            signal: controller.signal,
            resumed,
            images: item.images,
          })) {
            // 跟踪本轮 LLM 是否回应（text_delta=输出文本 / tool_call_start=开始用工具）→ 中断分情况依据
            if (event.type === 'text_delta' || event.type === 'tool_call_start') this.turnResponded = true;
            this.deps.callbacks.onEvent(event);
            if (event.type === 'completed') {
              completedEvent = event;
              break;
            }
          }
        } catch (err) {
          // runAgent 内部已 try/yield error；兜底未捕获异常 → 落 error 事件，循环继续 shift 下一条（不死循环）
          this.deps.callbacks.onEvent({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // 期间被 clear/resetSession（epoch 变）→ 丢弃回填，跳出（避免"复活"已清历史）
        if (turnEpoch !== this.epoch) break;

        // 回填真相源：任何 completed（done/repeated/max-iterations/aborted）都带回会话元信息。
        // sessionRef 始终更新（续接同会话）；messagesRef 按中断分情况：
        //   - aborted + 本轮 LLM 未回应（情况 A）→ 不回填（丢弃孤立 user），onTurnReverted 通知 UI 撤回；
        //   - 其余（done/repeated/max + aborted 已回应）→ 回填全量 messages（aborted 含中断前 partial，
        //     下次 submit 经 resumed 带上，不丢历史；若 aborted 不设 sessionRef，resumed 会 undefined，
        //     partial 白存）。非抢占：不自动重跑被中断的任务，仅保留历史供用户续接。
        if (completedEvent) {
          this.sessionRef = {
            id: completedEvent.sessionId,
            task: completedEvent.task,
            createdAt: completedEvent.createdAt,
          };
          if (completedEvent.reason === 'aborted' && !this.turnResponded) {
            this.deps.callbacks.onTurnReverted?.(item.text, item.images);
          } else {
            this.messagesRef = completedEvent.messages;
            if (completedEvent.reason === 'aborted') this.deps.callbacks.onTurnAborted?.();
          }
        }
      }
    } finally {
      this.busyRef = 'idle';
      this.abortRef = null;
      this.deps.callbacks.onBusyChange('idle');
      if (this.compactQueued) {
        this.compactQueued = false;
        void this.doCompact(); // doCompact finally 会 ensureRunLoop drain 剩余 queue
      } else {
        this.ensureRunLoop(); // 期间若有 submit 入队（如 clear 后重提），继续 drain
      }
    }
  }

  private async doCompact(): Promise<{ before: number; after: number } | null> {
    if (this.messagesRef.length === 0) return null;
    const before = this.messagesRef.length;
    this.busyRef = 'compacting';
    this.deps.callbacks.onBusyChange('compacting');
    try {
      const compressed = await this.deps.compactMessages(this.messagesRef, this.deps.getCompactOpts());
      if (compressed) {
        this.messagesRef = compressed;
        this.deps.callbacks.onMessagesReset(compressed);
        return { before, after: compressed.length };
      }
      return null; // 熔断（压到极限仍超限）
    } finally {
      this.busyRef = 'idle';
      this.deps.callbacks.onBusyChange('idle');
      this.ensureRunLoop(); // compact 期间若有 submit 入队，drain
    }
  }
}
