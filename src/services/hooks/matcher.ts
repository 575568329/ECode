/**
 * matcher 匹配（H3）：工具事件的 hook 用工具名过滤。
 *
 * 语法：`name`（精确）| `a|b`（列表）| `/re/` 或正则字面量（如 `^mcp__fs`）。
 * 非法正则回退字面量比较（容错——用户手写 config 不因一个坏正则全挂）。
 */

/** matcher 为空 = 匹配全部；matcher 非空而 toolName 为空 = 不匹配（matcher 只对工具事件有意义）。 */
export function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher.trim() === '') return true
  if (toolName === undefined) return false
  const segments = matcher.split('|').map((s) => s.trim()).filter((s) => s !== '')
  if (segments.length === 0) return true
  for (const seg of segments) {
    if (seg === toolName) return true
    try {
      if (new RegExp(seg).test(toolName)) return true
    } catch {
      // 非法正则（如未转义的括号）：字面量比较已在上方做过，跳过
    }
  }
  return false
}
