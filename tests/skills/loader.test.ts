// Skills（支点13 阶段1）loader 测试。
// 复用 subagent loader 模式：frontmatter 手写解析 + 两层作用域 + 同名覆盖 + 降级。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFile, loadSkills } from '../../src/skills/loader.js';

describe('parseSkillFile', () => {
  it('解析 frontmatter（name/description/allowedTools/model）+ 正文', () => {
    const md = `---
name: deploy
description: 标准化部署流程
allowedTools: bash, read_file
model: cheap
---
# 部署步骤
1. 跑测试`;
    const skill = parseSkillFile(md, 'user', '/x/deploy.md');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('deploy');
    expect(skill!.description).toBe('标准化部署流程');
    expect(skill!.allowedTools).toEqual(['bash', 'read_file']);
    expect(skill!.model).toBe('cheap');
    expect(skill!.body).toContain('部署步骤');
    expect(skill!.source).toBe('user');
  });

  it('allowedTools 支持 YAML 数组写法 [a, b]', () => {
    const md = `---
name: review
description: 代码审查
allowedTools: [grep, glob, read_file]
---
正文`;
    expect(parseSkillFile(md, 'project', '/x/review.md')!.allowedTools).toEqual([
      'grep',
      'glob',
      'read_file',
    ]);
  });

  it('缺 frontmatter name → 用文件名 stem 兜底', () => {
    const md = `---
description: 没 name 走 stem
---
正文`;
    expect(parseSkillFile(md, 'user', '/x/lint.md')!.name).toBe('lint');
  });

  it('无 frontmatter → null', () => {
    expect(parseSkillFile('纯正文无 frontmatter', 'user', '/x/a.md')).toBeNull();
  });

  it('缺 description → 空串（不致命）', () => {
    const md = `---
name: minimal
---
正文`;
    expect(parseSkillFile(md, 'user', '/x/minimal.md')!.description).toBe('');
  });

  it('CRLF 行尾兼容（Windows）', () => {
    const md = '---\r\nname: win\r\ndescription: crlf\r\n---\r\n正文';
    const skill = parseSkillFile(md, 'user', '/x/win.md');
    expect(skill!.name).toBe('win');
    expect(skill!.description).toBe('crlf');
  });
});

describe('loadSkills', () => {
  it('显式 dirs → 合并加载（project 覆盖 user 同名）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'skill-user-'));
    const projDir = mkdtempSync(join(tmpdir(), 'skill-proj-'));
    writeFileSync(join(userDir, 'shared.md'), '---\nname: shared\ndescription: 用户版\n---\n用户正文');
    writeFileSync(join(projDir, 'shared.md'), '---\nname: shared\ndescription: 项目版\n---\n项目正文');
    const skills = loadSkills({
      dirs: [
        { dir: userDir, source: 'user' },
        { dir: projDir, source: 'project' },
      ],
    });
    const shared = skills.find((s) => s.name === 'shared');
    expect(shared?.description).toBe('项目版'); // project 覆盖 user
    expect(shared?.source).toBe('project');
    expect(shared?.body).toBe('项目正文');
  });

  it('目录不存在 → []（降级不崩）', () => {
    expect(loadSkills({ dirs: [{ dir: '/不存在的目录', source: 'user' }] })).toEqual([]);
  });

  it('混入非 .md 文件 → 跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-mix-'));
    writeFileSync(join(dir, 'a.md'), '---\nname: a\ndescription: d\n---\n正文');
    writeFileSync(join(dir, 'b.txt'), '不是 skill');
    writeFileSync(join(dir, 'c.md'), '无 frontmatter 也跳过');
    const skills = loadSkills({ dirs: [{ dir, source: 'user' }] });
    expect(skills.map((s) => s.name)).toEqual(['a']); // b.txt 非 .md、c.md 无 frontmatter 都跳过
  });
});
