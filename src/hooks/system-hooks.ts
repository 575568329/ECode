// Hooks（支点 12）系统 hook 注册表 + 强制叠加。
//
// 系统 hook = agent 内置、不可被用户配置移除的 hook（收紧语义：只能加不能减，呼应支点 12 红线）。
//   - 恒前置（在用户 hook 之前跑）：最严决策先就位。
//   - getEffectiveHooks 合并 = [...SYSTEM_HOOKS, ...userHooks]，用户配置只能追加、无法过滤掉系统项。
//
// 一期 SYSTEM_HOOKS 留空（框架就位）：
//   - 具体系统 hook（如 rm -rf 拦截）是 command handler = spawn shell，跨平台 shell 分流（§9.3）需单独打磨，
//     不在此处硬塞一条会因环境差异静默失败的命令（§1.1 不把可用性寄托在管不了的外部环境）。
//   - M4 path-guard 已提供「敏感文件 / 越界写」的硬安全网；系统 hook 是其「动态版」，按需补内容即可，框架先行。
import type { HookDef } from './types.js';

/** 系统内置 hook（不可移除）。一期为空——见模块注释，框架先行，内容按需补。 */
export const SYSTEM_HOOKS: HookDef[] = [];

/**
 * 合并系统 + 用户 hook。系统恒前置、不可被移除（用户配置只能追加）。
 * 这是支点 12「只能收紧不能放宽」红线的实现点：系统收紧项永驻。
 */
export function getEffectiveHooks(userHooks: HookDef[]): HookDef[] {
  return [...SYSTEM_HOOKS, ...userHooks];
}
