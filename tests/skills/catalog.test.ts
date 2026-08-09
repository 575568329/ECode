// Skills（支点13 阶段1）catalog 测试。
// 重点：懒加载（只 name+description+allowedTools，不含 body 防爆）+ 空降级。
import { describe, it, expect } from 'vitest';
import { buildSkillsCatalog } from '../../src/skills/catalog.js';
import type { SkillDefinition } from '../../src/skills/types.js';

const skill = (over: Partial<SkillDefinition>): SkillDefinition => ({
  name: 's',
  description: 'd',
  body: '',
  source: 'user',
  filePath: '/s.md',
  ...over,
});

describe('buildSkillsCatalog', () => {
  it('空 → 空串（不注入 system prompt，零影响）', () => {
    expect(buildSkillsCatalog([])).toBe('');
  });

  it('非空 → 含标题 + 每个 skill 的 name+description', () => {
    const cat = buildSkillsCatalog([
      skill({ name: 'deploy', description: '标准化部署流程' }),
      skill({ name: 'code-review', description: '代码审查 checklist' }),
    ]);
    expect(cat).toContain('可用技能');
    expect(cat).toContain('deploy');
    expect(cat).toContain('标准化部署流程');
    expect(cat).toContain('code-review');
    expect(cat).toContain('代码审查 checklist');
  });

  it('懒加载：catalog 不含正文 body（防 prompt 爆炸）', () => {
    const cat = buildSkillsCatalog([
      skill({ name: 'secret', description: '机密菜谱', body: '这是不该泄露的机密正文内容' }),
    ]);
    expect(cat).not.toContain('不该泄露的机密正文');
  });

  it('allowedTools 标注（catalog 提示工具子集）', () => {
    const cat = buildSkillsCatalog([
      skill({ name: 'review', description: '审查', allowedTools: ['grep', 'read_file'] }),
    ]);
    expect(cat).toContain('grep');
    expect(cat).toContain('read_file');
  });

  it('无 allowedTools → 不追加工具标注', () => {
    const cat = buildSkillsCatalog([skill({ name: 'plain', description: '无工具限制' })]);
    expect(cat).not.toContain('工具：');
  });
});
