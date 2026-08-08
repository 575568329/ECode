// Hooks（支点 12）类型定义。
//
// hook = agent 生命周期关键事件上挂的自定义脚本（一期只做 command handler = spawn shell）。
//   - PreToolUse / PostToolUse：是「等决策」的 Promise-await（可 deny / 改输入输出），单向事件流承载不了。
//   - SessionStart / SessionEnd / UserPromptSubmit / Stop：走事件流（只通知）。阶段 2 一期事件流未接，先做 Pre/Post。
//
// 红线（支点 12 决策）：hook 只能收紧不能放宽——权限 deny 是硬边界，hook 不能覆盖。

/** 一期 6 核心事件（其他 SubagentStop/PreCompact/Notification 等后置）。 */
export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop';

export type HookSource = 'system' | 'user' | 'project' | 'project-local';

export interface HookDef {
  event: HookEvent;
  /** command handler：shell 命令（跨平台走 bash 工具同款 shell 分流）。http/prompt/agent handler 后置。 */
  command: string;
  /** PreToolUse/PostToolUse 的工具名 matcher（glob，如 'Bash' / 'Edit' / '*'），默认 '*'（全工具）。 */
  matcher?: string;
  source: HookSource;
}

/**
 * hook 决策结果。
 * - PreToolUse：deny → 不执行工具；modifiedInput → 替换工具输入。
 * - PostToolUse：modifiedOutput → 替换工具输出。
 * - 超时/失败默认 allow（系统级降级，不杀 agent）。
 */
export interface HookResult {
  decision: 'allow' | 'deny';
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  modifiedOutput?: string;
  /** Stop hook 打回继续（预留，一期事件流未接）。 */
  continue?: boolean;
}

/** 喂给 hook 的 stdin JSON 上下文（CC 协议，研究核实见 M5-方案解析 §3）。 */
export interface HookPayload {
  session_id?: string;
  tool_name?: string; // Pre/PostToolUse
  tool_input?: unknown; // PreToolUse（可被 modifiedInput 改）
  tool_response?: unknown; // PostToolUse（可被 modifiedOutput 改）
  prompt?: string; // UserPromptSubmit
}
