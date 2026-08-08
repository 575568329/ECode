// 阶段1 子代理：catalog prompt 构造测试。
import { describe, it, expect } from 'vitest';
import { buildAgentsCatalog } from '../src/subagent/prompt.js';
import type { AgentDefinition } from '../src/subagent/types.js';

const mk = (over: Partial<AgentDefinition>): AgentDefinition => ({
  name: 'x',
  description: 'd',
  systemPrompt: '正文（catalog 不应暴露）',
  ...over,
});

describe('buildAgentsCatalog', () => {
  it('空 agents → 空串（不注入，主 LLM 不知道就不会乱调 Task）', () => {
    expect(buildAgentsCatalog([])).toBe('');
  });

  it('含 name + description（主 LLM 据此决定派谁）', () => {
    const s = buildAgentsCatalog([mk({ name: 'reviewer', description: '审查代码质量与风险' })]);
    expect(s).toContain('reviewer');
    expect(s).toContain('审查代码质量与风险');
  });

  it('tools 子集标注（让主 LLM 知道该分身权限范围）', () => {
    const s = buildAgentsCatalog([mk({ name: 'ro', description: '只读分析', tools: ['read_file', 'grep'] })]);
    expect(s).toContain('read_file');
    expect(s).toContain('grep');
  });

  it('懒加载：不暴露完整 systemPrompt（正文等派遣时才读）', () => {
    const s = buildAgentsCatalog([mk({ name: 'a', description: 'd', systemPrompt: '绝密人设正文' })]);
    expect(s).not.toContain('绝密人设正文');
  });
});
