// 通配符匹配（抄 opencode util/wildcard.ts）。
// 'npm run *' 匹配 'npm run test'；尾部 ' *' 变可选组（'ls *' 既匹配 'ls' 也匹配 'ls -la'）。

/**
 * 判断字符串是否匹配通配符 pattern。
 *
 * 算法：转义正则元字符 → `*` 转 `.*` / `?` 转 `.` → 尾部 ` *`（已变 ` .*`）改为可选组
 * `( .*)?` → `^...$` 全锚定。
 *
 * 跨平台：反斜杠归一为 `/`（Windows 路径分隔符，避免被当转义）；`si` flag 大小写不敏感
 * （Windows 命令不区分大小写；Linux 命令本就小写，无副作用）。
 *
 * 注意调用方：toAlwaysPattern 固定追加 ' *'（带空格），勿直接用 'ls*'（无空格会退化为前缀匹配，
 * 'ls*' 会误命中 'lstmeval'）。
 */
export function match(str: string, pattern: string): boolean {
  // 归一反斜杠（Windows 路径），避免 '\' 被当成正则转义
  const normalizedStr = str.replace(/\\/g, '/');
  // 1. 转义正则元字符（* ? 留待下一步转通配）
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // 2. * → .*, ? → .
  const wildcarded = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  // 3. 尾部 ' *'（已被转成 ' .*'）改为可选组：( .*)?
  //    使 'ls *' 既匹配 'ls'（无参数）也匹配 'ls -la'（有参数）。
  const optionalTail = wildcarded.replace(/ \.\*$/, '( .*)?');
  // 4. 全锚定 + si（dotall 跨行 + 大小写不敏感）
  return new RegExp(`^${optionalTail}$`, 'si').test(normalizedStr);
}
