// 双模式入口的纯逻辑：根据 CLI 参数决定走 REPL 沉浸式还是 one-shot。
// 抽离出来便于单测——src/index.ts 顶层执行，不可直接 import 做测试。
//
// 判定规则（spec §八 阶段②验收：`ecode`(无参 + TTY) 进 REPL；`ecode "任务"` 仍走 one-shot）：
//   --repl 显式触发   → repl   （即便非 TTY，方便自动化/测试驱策 REPL）
//   有位置参数（任务）→ oneshot（保留现状 `ecode "任务"` 逐字流式）
//   无任务 + TTY      → repl   （交互终端默认沉浸式入口）
//   无任务 + 非 TTY   → usage  （管道/CI：打印用法并退出，避免 Ink 抢占无输入源的 stdin）
//
// 为什么「非 TTY 无任务」不进 REPL：管道/CI 下 Ink 抢占 stdin/stdout 会出现
// 无输入源 + 渲染污染下游管道的尴尬；保留 printUsage 退出更安全（呼应 CLAUDE.md §1.1
// 「配置与依赖方向」：别把正常工作寄托在无法控制的外部环境上）。

export interface EntryModeInput {
  /** `--repl` 标志：显式要求 REPL。 */
  replFlag: boolean;
  /** 是否有位置参数（任务描述）。 */
  hasTask: boolean;
  /** stdout 是否交互终端（process.stdout.isTTY === true）。 */
  isTTY: boolean;
}

export type EntryMode = 'repl' | 'oneshot' | 'usage';

/**
 * 入口模式判定（纯函数，无副作用）。
 *
 * 优先级：--repl > 有任务 > TTY 状态。
 * - `--repl` 最强：即便管道模式也强制 REPL（为集成测试/脚本驱策留口子）。
 * - 否则有任务走 one-shot（现状不变）。
 * - 否则看 TTY：交互终端进 REPL，非交互走 usage 退出。
 */
export function selectEntryMode(input: EntryModeInput): EntryMode {
  if (input.replFlag) return 'repl';
  if (input.hasTask) return 'oneshot';
  return input.isTTY ? 'repl' : 'usage';
}
