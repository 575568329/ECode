// Hooks（支点 12）gate 聚合层：把多个 HookDef 聚成 Pre/Post 两个 await 回调。
//
// 职责（runner 只解析单 hook，本模块管「多 hook 怎么合」）：
//   - PreToolUse：按声明顺序串行跑匹配 hook；deny 即终态短路返回；modifiedInput 整体替换。
//   - PostToolUse：按声明顺序跑匹配 hook；deny 累积（reason 给 agent 回喂 LLM）。
//   - matcher：'*' / 缺省 = 全工具；否则 CI 精确匹配，支持 'Bash|Edit' / 'Bash,Edit' 备选 + 'Bash*' 前缀。
//
// 红线（runner 已守）：单 hook 超时/失败 → allow 降级；本层 deny > allow 最严胜出。
import { runHook } from './runner.js';
import type { ShellExec } from './runner.js';
import type { HookDef, HookResult, HookEvent } from './types.js';

export interface HookGate {
  /** PreToolUse：返回 deny → agent 跳过执行（同权限 deny）；modifiedInput → 替换工具输入。 */
  preToolUse: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<HookResult>;
  /** PostToolUse：返回 deny → agent 把 reason 回喂 LLM（工具已执行，不可撤销，仅反馈）。 */
  postToolUse: (
    toolName: string,
    input: Record<string, unknown>,
    output: string,
  ) => Promise<HookResult>;
}

/**
 * matcher 判定（CI）：'*' 或缺省 = 全工具；'Bash*' 前缀；'Bash|Edit' / 'Bash,Edit' 备选。
 * ECode 工具名小写（'bash'），CC matcher 常写首字母大写（'Bash'）——CI 归一消除差异。
 */
function hookMatcher(pattern: string | undefined, toolName: string): boolean {
  const p = (pattern ?? '*').trim().toLowerCase();
  if (p === '*') return true;
  const t = toolName.toLowerCase();
  if (p.endsWith('*')) return t.startsWith(p.slice(0, -1));
  return p.split(/[|,]/).map((s) => s.trim()).includes(t);
}

/**
 * 构造 hook gate。hooks 为空 → 仍返回 gate（pre/post 恒 allow），调用方据此可短路。
 * exec 可注入（测试）；生产用 runner 默认 spawn。
 */
export function createHookGate(
  hooks: HookDef[],
  deps: { exec?: ShellExec; timeoutMs?: number } = {},
): HookGate {
  const preToolUse: HookGate['preToolUse'] = async (toolName, input) => {
    let result: HookResult = { decision: 'allow' };
    for (const def of hooks) {
      if (def.event !== 'PreToolUse') continue;
      if (!hookMatcher(def.matcher, toolName)) continue;
      const r = await runHook(
        def,
        { tool_name: toolName, tool_input: input },
        deps,
      );
      // deny 即终态（最严胜出），立刻短路
      if (r.decision === 'deny') {
        return { decision: 'deny', reason: r.reason };
      }
      // modifiedInput 整体替换（CC hso.updatedInput 语义：覆盖整个 tool_input）
      if (r.modifiedInput) {
        result = { ...result, modifiedInput: r.modifiedInput };
      }
    }
    return result;
  };

  const postToolUse: HookGate['postToolUse'] = async (toolName, input, output) => {
    for (const def of hooks) {
      if ((def.event as HookEvent) !== 'PostToolUse') continue;
      if (!hookMatcher(def.matcher, toolName)) continue;
      const r = await runHook(
        def,
        { tool_name: toolName, tool_input: input, tool_response: output },
        deps,
      );
      // PostToolUse deny：工具已跑，不可撤销——把 reason 带回，agent 回喂 LLM
      if (r.decision === 'deny') {
        return { decision: 'deny', reason: r.reason };
      }
    }
    return { decision: 'allow' };
  };

  return { preToolUse, postToolUse };
}
