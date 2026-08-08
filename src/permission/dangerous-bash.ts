// 5c：bash 危险模式检测（spec M4 阶段5c，仿 CC destructiveCommandWarning）。
// 纯函数：扫命令文本，返回匹配到的危险提示串数组（空=安全）。
//
// 定位：仅「警告/高亮」，不影响权限判定逻辑（是否仍弹窗由 rule-engine 决定）。
// 目的是让用户在审批弹窗里对 rm -rf / git push --force 这类不可逆操作多一层醒目提示。
// 保守优先：宁可不匹配（漏告警）也不该把安全命令误判为危险。tree-sitter 级精确解析
// 被 §9.3 红线禁用，正则足够覆盖现实中的典型破坏性形态。

interface DangerousPattern {
  /** 正则；命中即返回对应 message。 */
  regex: RegExp;
  /** 人类可读告警（含命令骨架，便于用户定位）。 */
  message: string;
}

// 按破坏性从高到低排列；同一命令可能命中多条（复合命令），各返回一条。
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // rm 同时带 r/R（递归）与 f/F（强删）：不可恢复地删除整棵子树。
  // 两段式覆盖 -rf / -fr 两种 flag 顺序；i 标志兼容大写 -RF。
  { regex: /\brm\s+(?:-\S*\s+)*-[a-z]*r[a-z]*f/i, message: 'rm 递归强删（-rf）：整目录删除，不可恢复' },
  { regex: /\brm\s+(?:-\S*\s+)*-[a-z]*f[a-z]*r/i, message: 'rm 递归强删（-fr）：整目录删除，不可恢复' },
  // git push --force / -f：覆盖远程历史，他人提交丢失。
  // (?!\S) 确保 --force 是完整 token（不误伤较安全的 --force-with-lease）。
  { regex: /\bgit\s+push\b[\s\S]*?(?:--force|-f)(?!\S)/, message: 'git push 强制推送：覆盖远程历史' },
  // git reset --hard：丢弃工作区与暂存区未提交更改。
  { regex: /\bgit\s+reset\s+--hard\b/, message: 'git reset --hard：丢弃未提交更改' },
  // chmod -R：递归改权限，波及整棵子树（常被误用于 777）。
  { regex: /\bchmod\s+-R\b/, message: 'chmod 递归改权限（-R）：波及整棵子树' },
  // fork 炸弹：耗尽进程资源。
  { regex: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, message: 'fork 炸弹：耗尽进程资源' },
  // curl/wget 管道喂给 shell：执行来源不可信的远程脚本。
  { regex: /\b(?:curl|wget)\b[\s\S]*?\|\s*(?:sh|bash|zsh)\b/, message: '管道执行远程脚本：来源不可信危及本机' },
];

/**
 * 检测 bash 命令中的危险模式，返回告警串数组（空=未发现危险）。
 * 多条命中各返回一条（复合命令 rm -rf a && git push -f → 2 条）。
 */
export function detectDangerousBash(command: string): string[] {
  if (!command) return [];
  const warns: string[] = [];
  for (const p of DANGEROUS_PATTERNS) {
    if (p.regex.test(command)) warns.push(p.message);
  }
  return warns;
}
