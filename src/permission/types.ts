/**
 * M4 权限系统类型定义。
 * 设计来源：M4-三源交叉验证报告（3 档 / last wins / 三原子 action）。
 */

/** 三档模式（砍 plan/dontAsk，plan 用 deny 规则模拟） */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypass';

/** 规则动作三原子（仿 opencode ask/allow/deny） */
export type RuleAction = 'allow' | 'deny' | 'ask';

/**
 * 单条权限规则（settings-loader 解析 + 会话 allow_always 累积共用此形状）。
 * - tool：工具名（已别名归一，如 'bash'/'edit_file'），'*' = 通配所有工具。
 * - pattern：命令/路径模式，'*' 通配（如 'rm -rf *' / '.env' / '*'）。
 * - action：匹配后的判定（deny 最强，check() 优先短路）。
 * - source：来源层，调试/排序用（user/project/settings 之外的 session 为运行时累积）。
 */
export interface Rule {
  tool: string;
  pattern: string;
  action: RuleAction;
  source: 'user' | 'project' | 'session';
}

/** check() 返回的判定结果（判别联合，携带 reason 供日志/回喂） */
export type PermissionVerdict =
  | { action: 'allow'; reason: string }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string };

/**
 * 权限门用户决策三态（修 🔴-2 关键）。
 * 旧版 PermissionGate.ask 仅返回 'allow'|'deny'，核心层无法区分「本次」与「永久」→ 无条件 add → 语义塌陷。
 * 三态后：核心层仅在 allow_always 时记会话规则，allow_once 不记。
 */
export type GateDecision = 'allow_once' | 'allow_always' | 'deny';
