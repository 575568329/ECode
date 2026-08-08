// 子代理（支点 9）prompt 构造：把 agents catalog 注入主代理 system prompt。
//
// 懒加载原则：catalog 只暴露 name + description（+ tools 子集标注），**不**暴露完整 systemPrompt
// （主 LLM 只需知道「能派谁、何时派」，人设正文等真正派遣时才读）。
import type { AgentDefinition } from './types.js';

/**
 * 拼「可派遣子代理」目录段（注入主 system prompt 末尾）。
 * 空 agents → 空串（不注入，主 LLM 不知道有子代理就不会乱调 Task）。
 */
export function buildAgentsCatalog(agents: AgentDefinition[]): string {
  if (agents.length === 0) return '';
  const lines = agents.map((a) => {
    const toolsNote = a.tools?.length ? `（工具限定：${a.tools.join(', ')}）` : '';
    return `- **${a.name}**：${a.description}${toolsNote}`;
  });
  return ['## 可派遣的子代理（用 Task 工具派发，独立上下文、只回结论）', ...lines].join('\n');
}
