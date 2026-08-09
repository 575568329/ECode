// Skills（支点 13 阶段1）catalog：拼「可用技能」段注入主代理 system prompt。
//
// 懒加载原则（对齐 buildAgentsCatalog）：catalog 只暴露 name + description（+ allowedTools 标注），
// **不**暴露正文 body——主 LLM 只需知道「有什么菜谱、何时用」，正文等真正触发（/skill）才读。
// 空 skills → 空串（不注入，零影响）。
import type { SkillDefinition } from './types.js';

/**
 * 拼「可用技能」目录段（注入主 system prompt 末尾）。
 * 空 skills → 空串（不注入，主 LLM 不知道有 skill 就不会乱调）。
 */
export function buildSkillsCatalog(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const toolsNote = s.allowedTools?.length ? `（工具：${s.allowedTools.join(', ')}）` : '';
    return `- **${s.name}**：${s.description}${toolsNote}`;
  });
  return ['## 可用技能（用 /skill <name> 调用，或我会自动匹配）', ...lines].join('\n');
}
