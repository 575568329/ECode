// 权限判定纯逻辑（档A：CCode 式 dangerous 二元）。
// 只决定「是否需要询问」+ 记住「已批准」。询问/弹窗本身由 UI 层（阶段②）注入回调实现。

/**
 * 会话级允许列表（always-allow）。
 * 内存版：Set<toolName>。持久化（.ecode/settings.local.json）留 M4，接口形状预留。
 */
export class AllowList {
  private readonly granted = new Set<string>();

  has(toolName: string): boolean {
    return this.granted.has(toolName);
  }

  /** 记住某工具已批准（本会话后续不再询问）。 */
  add(toolName: string): void {
    this.granted.add(toolName);
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
 * 权限决策回调契约（注入式）：UI 层（阶段② Ink 的 PermissionDialog）实现 ask，
 * 阶段①测试用 mock。runAgentStream 遇 dangerous 工具时调它，据返回值放行/拒绝。
 */
export interface PermissionGate {
  ask(req: { toolName: string; input: Record<string, unknown> }): Promise<'allow' | 'deny'>;
}
