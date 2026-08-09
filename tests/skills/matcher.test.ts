// Skills（支点13 阶段1）matcher 测试。
// getSkillBody：手动 /skill 触发读正文（懒加载），大小写不敏感。
import { describe, it, expect } from 'vitest';
import { getSkillBody } from '../../src/skills/matcher.js';
import type { SkillDefinition } from '../../src/skills/types.js';

const skills: SkillDefinition[] = [
  { name: 'deploy', description: 'd', body: '部署正文', source: 'user', filePath: '/a.md' },
  { name: 'review', description: 'd', body: '审查正文', source: 'project', filePath: '/b.md' },
];

describe('getSkillBody', () => {
  it('命中 → 返回正文（手动 /skill 触发读 body）', () => {
    expect(getSkillBody('deploy', skills)).toBe('部署正文');
  });

  it('未命中 → null', () => {
    expect(getSkillBody('nope', skills)).toBeNull();
  });

  it('大小写不敏感（/skill Deploy 命中 deploy）', () => {
    expect(getSkillBody('Deploy', skills)).toBe('部署正文');
    expect(getSkillBody('REVIEW', skills)).toBe('审查正文');
  });
});
