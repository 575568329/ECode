// 5d：doom_loop（死循环）检测（spec M4 阶段5d，仿 opencode session/processor.ts:356-380）。
// 追踪「同工具 + 相同输入」的连续重复次数；达阈值即判定死循环嫌疑。
//
// Why：LLM 卡在重试同一工具的循环里（如反复 read 同一文件、反复跑同一失败命令），
// 会静默烧 token。检测到后强制权限询问，让用户 continue（继续一次）或 abort（拒绝本次）
// 打破循环——不硬中断，交还决策权。
//
// 跨轮持久：detector 在一次 runAgentStream 内实例化一次，跨多轮 tool 循环存活，
// 才能捕获「连续 N 轮重试同一工具」的经典 doom loop。

/** 连续重复多少次判定为 doom loop。3 = 第 3 次相同调用触发（opencode 同阈）。 */
export const DOOM_LOOP_THRESHOLD = 3;

/** 当前连续重复次数是否达到 doom 阈值。 */
export function isDoomLoop(count: number): boolean {
  return count >= DOOM_LOOP_THRESHOLD;
}

/**
 * 稳定序列化：把工具输入对象按 key 排序后 JSON 化，使键顺序不同但内容相同的输入
 * 产生同一 key（{a:1,b:2} 与 {b:2,a:1} 视为同一调用）。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  // 数组保序；对象按 key 排序。
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export class DoomLoopDetector {
  private lastKey = '';
  private count = 0;

  /**
   * 记录一次工具调用，返回当前连续重复次数。
   * 工具名或输入任一变化 → 重新计 1；相同 → 递增。
   */
  observe(toolName: string, input: Record<string, unknown>): number {
    const key = `${toolName}:${stableStringify(input)}`;
    if (key === this.lastKey) {
      this.count += 1;
    } else {
      this.lastKey = key;
      this.count = 1;
    }
    return this.count;
  }

  /** 清空计数（用于显式重置，如用户 abort 后）。 */
  reset(): void {
    this.lastKey = '';
    this.count = 0;
  }
}
