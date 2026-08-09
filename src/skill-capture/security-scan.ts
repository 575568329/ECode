// ============================================================
// 安全扫描（M6 阶段D 技能生成 · §6）—— SKILL.md 内容危险模式检测
// ============================================================
// 借鉴 openclaw Skill Workshop scanner.ts：三段式（归纳产出时扫 + accept 前再扫 + critical 强制 quarantine）。
// 增强（§17🟡1）：rm -rf 锚定危险根（不误报 build/）、中文 prompt-injection、base64 外泄绕过明文扫描。
// 规则 pattern 无 g 标志（避免 match 的 lastIndex 跨调用累积）。

export type Severity = 'critical' | 'warn';

export interface Finding {
  rule: string;
  severity: Severity;
  /** 命中的文本片段（审批 UI 展示 + 诊断用）。 */
  match: string;
}

export interface ScanResult {
  findings: Finding[];
  /** 是否含 critical（true → 强制 quarantine，拒绝 apply）。 */
  hasCritical: boolean;
}

/** 规则集（§6 表，按 critical → warn 排序）。 */
const RULES: ReadonlyArray<{ rule: string; severity: Severity; pattern: RegExp; desc: string }> = [
  {
    rule: 'shell-pipe-to-shell',
    severity: 'critical',
    pattern: /(curl|wget)[^\n|]*\|\s*(sh|bash)\b/,
    desc: '远程脚本直接管道执行（RCE）',
  },
  {
    rule: 'secret-exfiltration',
    severity: 'critical',
    pattern: /process\.env[\s\S]*?(fetch|curl|wget|http)\b/,
    desc: '读取环境变量后外发（凭证泄露）',
  },
  {
    rule: 'base64-exfiltration',
    severity: 'critical',
    pattern: /Buffer\.from\([^)]*base64[\s\S]*?(fetch|http|net)\b/,
    desc: 'base64 编码外发（绕过明文扫描）',
  },
  {
    // 锚定危险根：/ ~ $HOME 或 .（后跟空格/行尾/斜杠）。普通 rm -rf build/ 不误报。
    rule: 'destructive-delete',
    severity: 'warn',
    pattern: /rm\s+-rf\s+(\/|~|\$HOME|\.(?:\s|$|\/))/,
    desc: '删除危险根目录（/ ~ $HOME .）',
  },
  {
    rule: 'unsafe-permissions',
    severity: 'warn',
    pattern: /chmod\s+777\b/,
    desc: '过度开放权限',
  },
  {
    rule: 'prompt-injection-ignore',
    severity: 'critical',
    pattern: /ignore\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+instructions|ignore\s+all\s+instructions|忽略(上面|之前|所有)的?指令/i,
    desc: '提示注入：要求忽略既有指令',
  },
  {
    rule: 'prompt-injection-system',
    severity: 'critical',
    pattern: /system\s+prompt|developer\s+message|hidden\s+instructions|系统提示词|开发者消息|隐藏指令/i,
    desc: '提示注入：探测系统提示',
  },
  {
    rule: 'prompt-injection-tool',
    severity: 'critical',
    pattern: /绕过(工具|审批|权限)|bypass\s+(tool|approval|permission)/i,
    desc: '提示注入：绕过工具审批',
  },
];

/** 扫描 SKILL.md 内容，返回所有命中（按规则定义顺序）。hasCritical = 含任意 critical。 */
export function scanSkillContent(content: string): ScanResult {
  const findings: Finding[] = [];
  for (const r of RULES) {
    const m = content.match(r.pattern);
    if (m) findings.push({ rule: r.rule, severity: r.severity, match: m[0] });
  }
  return { findings, hasCritical: findings.some((f) => f.severity === 'critical') };
}
