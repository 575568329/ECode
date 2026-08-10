// failure-tracker.ts —— 工具连续失败追踪器（公共组件）
//
// 与 DoomLoopDetector / errorStreak 的关系（三者各司其职）：
//   ┌─────────────────────┬───────────────────────┬──────────────────┬─────────────────────────┐
//   │ 组件                 │ 检测什么               │ 到阈值后          │ 适用范围                 │
//   ├─────────────────────┼───────────────────────┼──────────────────┼─────────────────────────┤
//   │ DoomLoopDetector     │ 完全相同的 (tool,input) │ 弹窗询问用户      │ 防死循环                 │
//   │ errorStreak(内联)    │ MCP 工具连续 isError    │ 禁用工具（熔断）   │ MCP 不可信代码           │
//   │ ToolFailureTracker   │ 任意工具连续 isError    │ 提醒 LLM 换策略   │ 内置工具试错检测（公共）   │
//   └─────────────────────┴───────────────────────┴──────────────────┴─────────────────────────┘
//
// 为什么不复用 errorStreak：
//   errorStreak 有熔断链路（disabledTools 从工具列表移除），适合 MCP（不可信代码）；
//   内置工具（bash/read_file/grep）失败是业务常态（build 失败、grep 无匹配），不该禁用，只需提醒。
//   语义不同，强行合并会增加条件分支。

/**
 * 单个工具的连续失败记录。
 * - streak: 连续失败次数（成功即归零）
 * - lastError: 最近一次失败的错误消息（注入提醒时附带，帮 LLM 定位问题）
 */
interface FailureRecord {
  streak: number;
  lastError: string;
}

/** 追踪结果：是否触发提醒 + 提醒文本。 */
export interface FailureCheckResult {
  /** 是否达到阈值（调用方据此决定是否注入提醒 / yield warning）。 */
  triggered: boolean;
  /** 提醒文本（triggered=true 时有意义；LLM 可读的自然语言）。 */
  message: string;
  /** 当前连续失败次数（未达阈值时也有值，供调用方判断严重度）。 */
  streak: number;
}

/**
 * 工具连续失败追踪器。
 *
 * 核心语义：
 *   - 同一工具连续失败 N 次（参数可能每次不同）→ 触发提醒
 *   - 成功一次即归零（偶发失败不累积）
 *   - 提醒只在首次达阈值时触发（streak === threshold），不重复打扰
 *   - 触发后继续失败不重复触发（避免每轮都注入），除非失败次数翻倍（给第二次机会）
 *
 * 设计为纯逻辑（无副作用、无 I/O），方便独立测试。
 */
export class ToolFailureTracker {
  private readonly records = new Map<string, FailureRecord>();
  private readonly threshold: number;
  /** 已触发过提醒的 (toolName → streak) 快照，避免在同一阈值反复触发。 */
  private readonly firedAt = new Map<string, number>();

  /**
   * @param threshold 连续失败多少次触发提醒（默认 3）。
   * 太低则误报（grep 无匹配也提醒）；太高则失去意义（LLM 已白烧很多轮）。
   */
  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  /**
   * 记录一次工具执行结果，返回是否应提醒 LLM。
   *
   * @param toolName 工具名（如 'bash'、'mcp__zread__read_file'）
   * @param isError 本次执行是否失败
   * @param errorContent 失败时的错误文本（成功时传 undefined 或忽略）
   * @returns 提醒检查结果（triggered + message）
   */
  observe(toolName: string, isError: boolean, errorContent?: string): FailureCheckResult {
    if (!isError) {
      // 成功即归零（偶发失败恢复不累积）
      this.records.delete(toolName);
      this.firedAt.delete(toolName);
      return { triggered: false, message: '', streak: 0 };
    }

    const prev = this.records.get(toolName);
    const streak = (prev?.streak ?? 0) + 1;
    const lastError = errorContent ?? prev?.lastError ?? '';
    this.records.set(toolName, { streak, lastError });

    // 只在 streak === threshold 时触发（首次达阈值）。
    // 之后翻倍时再触发一次（给第二次提醒，但不每轮都触发）。
    const lastFired = this.firedAt.get(toolName);
    const shouldFire = streak === this.threshold || (lastFired !== undefined && streak >= lastFired * 2);
    if (shouldFire) {
      this.firedAt.set(toolName, streak);
    }

    return {
      triggered: shouldFire,
      message: shouldFire ? this.buildMessage(toolName, streak, lastError) : '',
      streak,
    };
  }

  /**
   * 构建提醒文本（注入 messages 回喂 LLM）。
   * 包含：工具名 + 连续失败次数 + 最近错误摘要 + 换策略建议。
   */
  private buildMessage(toolName: string, streak: number, lastError: string): string {
    const errorPreview = lastError ? lastError.slice(0, 200) : '未知错误';
    return (
      `[系统提醒] 工具 ${toolName} 已连续失败 ${streak} 次（每次参数不同）。` +
      `最近错误：${errorPreview}\n` +
      `可能是环境/路径/语法问题，建议换一种策略，不要继续用相同方式试错。`
    );
  }

  /** 获取某工具当前连续失败次数（测试 / 调试用）。 */
  getStreak(toolName: string): number {
    return this.records.get(toolName)?.streak ?? 0;
  }

  /** 清空所有记录（会话重置用）。 */
  reset(): void {
    this.records.clear();
    this.firedAt.clear();
  }
}
