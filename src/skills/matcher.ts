// Skills（支点 13 阶段1）matcher：手动 /skill 触发读正文（懒加载 body）。
//
// 自动匹配 = LLM 看到 catalog（system prompt 注入）后主动在回复中说明用了哪个 skill，
// 无需专门工具（方案 §阶段1：LLM 决策，走 system prompt catalog）。本模块只管手动取 body。
import type { SkillDefinition } from './types.js';

/**
 * 手动 /skill <name> 触发：取该 skill 正文（注入对话交主 LLM 跑）。
 * 大小写不敏感（/skill Deploy 命中 deploy）。未命中 → null。
 */
export function getSkillBody(name: string, skills: SkillDefinition[]): string | null {
  const found = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return found ? found.body : null;
}
