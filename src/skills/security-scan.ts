// Skills（支点 13 阶段2）安全扫描 —— 提案落盘前的危险模式兜底（决策点 D7）。
//
// 定位：自动扫「显而易见的危险」（rm -rf / / 密钥 / 外发 / fork 炸弹），兜底防 LLM 归纳出的
// 菜谱含致命操作。**不替代人工 review**——正文质量、隐蔽风险仍需人把关（自动扫 + 人工审）。
// 纯函数（正则扫描），零 IO，全场景可单测。命中 → accept 拦截强制人工二次确认。
import type { SkillProposal } from './types.js';

export interface ScanReport {
  /** true = 无危险模式命中（可 accept）；false = 命中（拦截，强制人工 review）。 */
  passed: boolean;
  /** 命中的危险模式标签清单（供 UI 展示）。 */
  risks: string[];
}

/**
 * 本期默认危险模式（正则）。后置：用户可配置自定义模式 / 白名单。
 * - 递归删根 / 用户目录（rm -rf / ~）
 * - 云平台密钥（AWS AKIA / GitHub ghp / GitLab glpat / Slack xox*）
 * - 外发数据（curl/wget POST/PUT 外部）
 * - fork 炸弹、chmod 777
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+-rf?\s+\/(\s|$)/, label: '递归删除根目录（rm -rf /）' },
  { pattern: /\brm\s+-rf?\s+~/, label: '递归删除用户目录（rm -rf ~）' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS 访问密钥（AKIA…）' },
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, label: 'GitHub 令牌（ghp_…）' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/, label: 'GitLab 令牌（glpat-…）' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/, label: 'Slack 令牌（xox…）' },
  { pattern: /\b(curl|wget)\b[\s\S]*?(-X\s*(POST|PUT)|--data[^|]|-d\s)/, label: '外发数据（curl/wget POST/PUT）' },
  { pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork 炸弹' },
  { pattern: /\bchmod\s+[-+]?777\b/, label: '过度开放权限（chmod 777）' },
];

/**
 * 扫描 skill 提案是否含危险模式（扫 name + description + body 全文）。
 * @returns passed=true 无命中；passed=false risks 列出所有命中标签（累积，非短路）。
 */
export function scanProposal(proposal: SkillProposal): ScanReport {
  const text = `${proposal.name}\n${proposal.description}\n${proposal.body}`;
  const risks: string[] = [];
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) risks.push(label);
  }
  return { passed: risks.length === 0, risks };
}
