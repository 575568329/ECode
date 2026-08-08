// 权限判定纯逻辑（档A：CCode 式 dangerous 二元；M4 升三态 gate）。
// 只决定「是否需要询问」+ 记住「已批准」。询问/弹窗本身由 UI 层注入回调实现。
// 主判定入口是 ./permission/rule-engine.ts 的 check()；shouldAsk/AllowList 保留作档 A 兼容。
import type { GateDecision } from './permission/types.js';
import { match } from './permission/wildcard.js';

/**
 * 会话级允许列表（always-allow）。
 * - 非 bash 工具：工具名粒度（granted Set），「整工具放行」语义保留（阶段 2）。
 * - bash：命令 pattern 粒度（bashPatterns Set），allow_always 生成归约后的命令骨架 pattern
 *   （如 'git checkout main' → 'git checkout *'），同类命令免询问、不同命令仍询问。
 *
 * 内存版：默认不写盘（防误点永久放行，交叉验证 §4.6）；持久化留阶段 4 settings-loader。
 */
export class AllowList {
  private readonly granted = new Set<string>();
  private readonly bashPatterns = new Set<string>();

  has(toolName: string): boolean {
    return this.granted.has(toolName);
  }

  /** 记住某（非 bash）工具已批准（本会话后续不再询问）。 */
  add(toolName: string): void {
    this.granted.add(toolName);
  }

  /** bash allow_always：记归约后的命令 pattern（如 'git checkout *'）。 */
  addBashPattern(pattern: string): void {
    if (pattern) this.bashPatterns.add(pattern);
  }

  /**
   * bash 判定：每个 compound 段都必须命中某已存 pattern（防 &&/||/;/| 绕过——
   * 一旦有段未批准则整条询问）。空段集恒不通过（[].every() 恒真陷阱）。
   */
  hasBashPermission(segments: string[]): boolean {
    if (segments.length === 0) return false;
    const patterns = Array.from(this.bashPatterns);
    if (patterns.length === 0) return false;
    return segments.every((seg) => patterns.some((p) => match(seg, p)));
  }
}

/**
 * 判定一次工具调用是否需要请求权限。
 * 档A规则：已在 allow 列表 → 放行；否则仅 dangerous 工具需询问。
 */
export function shouldAsk(toolName: string, isDangerous: boolean, allow: AllowList): boolean {
  if (allow.has(toolName)) return false;
  return isDangerous;
}

/**
 * 权限决策回调契约（注入式）：UI 层（Ink PermissionDialog）实现 ask，测试用 mock。
 * runAgentStream 遇需询问的工具时调它，据返回值放行/拒绝。
 *
 * M4 升三态（修 🔴-2）：旧版仅 'allow'|'deny'，核心无法区分本次/永久 → 无条件 add → allow_once 下次不再问。
 * 三态后核心仅在 allow_always 时记会话规则。
 */
export interface PermissionGate {
  ask(req: { toolName: string; input: Record<string, unknown> }): Promise<GateDecision>;
}
