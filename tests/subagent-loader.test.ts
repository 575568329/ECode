// 阶段1 子代理：loader 测试（frontmatter 解析 + user/project 两层作用域合并）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgents, parseAgentFile } from '../src/subagent/loader.js';

let userAgentsDir: string;
let projectAgentsDir: string;

function setup(): void {
  userAgentsDir = mkdtempSync(join(tmpdir(), 'ecode-agents-user-'));
  projectAgentsDir = mkdtempSync(join(tmpdir(), 'ecode-agents-project-'));
}
function teardown(): void {
  rmSync(userAgentsDir, { recursive: true, force: true });
  rmSync(projectAgentsDir, { recursive: true, force: true });
}

describe('parseAgentFile', () => {
  it('解析 frontmatter（name/description/tools）+ 正文', () => {
    const def = parseAgentFile(`---
name: code-reviewer
description: 审查代码质量与风险
tools: read_file, grep, glob
---
你是代码审查员，专注质量与风险。`);
    expect(def?.name).toBe('code-reviewer');
    expect(def?.description).toBe('审查代码质量与风险');
    expect(def?.tools).toEqual(['read_file', 'grep', 'glob']);
    expect(def?.systemPrompt).toBe('你是代码审查员，专注质量与风险。');
  });

  it('tools 可选（未写 → undefined，子代理用全工具）', () => {
    const def = parseAgentFile(`---
name: helper
description: 通用助手
---
通用。`);
    expect(def?.tools).toBeUndefined();
  });

  it('model 可选（解析但本里程碑不用）', () => {
    const def = parseAgentFile(`---
name: deep-helper
description: d
model: glm-5.2
---
D`);
    expect(def?.model).toBe('glm-5.2');
  });

  it('无 frontmatter → null（不合法，跳过）', () => {
    expect(parseAgentFile('纯正文无人设')).toBeNull();
  });

  it('缺 name → null（无法被主 LLM 点名派遣）', () => {
    expect(
      parseAgentFile(`---
description: 没 name
---
正文`),
    ).toBeNull();
  });

  it('tools 支持 YAML 数组写法 [a, b]', () => {
    const def = parseAgentFile(`---
name: x
description: x
tools: [read_file, grep]
---
X`);
    expect(def?.tools).toEqual(['read_file', 'grep']);
  });
});

describe('loadAgents', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('空目录 → []', () => {
    expect(loadAgents({ dirs: [userAgentsDir, projectAgentsDir] })).toEqual([]);
  });

  it('加载 user + project 全部 agent', () => {
    writeFileSync(join(userAgentsDir, 'reviewer.md'), '---\nname: reviewer\ndescription: r\n---\nR');
    writeFileSync(join(projectAgentsDir, 'tester.md'), '---\nname: tester\ndescription: t\n---\nT');
    const agents = loadAgents({ dirs: [userAgentsDir, projectAgentsDir] });
    expect(agents.map((a) => a.name).sort()).toEqual(['reviewer', 'tester']);
  });

  it('同名 project 覆盖 user（project 胜，后加载覆盖）', () => {
    writeFileSync(join(userAgentsDir, 'shared.md'), '---\nname: shared\ndescription: user-ver\n---\nU');
    writeFileSync(join(projectAgentsDir, 'shared.md'), '---\nname: shared\ndescription: project-ver\n---\nP');
    const agents = loadAgents({ dirs: [userAgentsDir, projectAgentsDir] });
    const shared = agents.find((a) => a.name === 'shared');
    expect(shared?.description).toBe('project-ver');
  });

  it('非 .md 文件跳过；非法 .md 跳过不崩', () => {
    writeFileSync(join(userAgentsDir, 'readme.txt'), 'not an agent');
    writeFileSync(join(userAgentsDir, 'bad.md'), '---\ndescription: no name\n---\nX');
    writeFileSync(join(userAgentsDir, 'good.md'), '---\nname: good\ndescription: g\n---\nG');
    const agents = loadAgents({ dirs: [userAgentsDir] });
    expect(agents.map((a) => a.name)).toEqual(['good']);
  });

  it('目录不存在 → [] 不抛（优雅降级）', () => {
    expect(loadAgents({ dirs: [join(tmpdir(), 'ecode-agents-no-such-' + Math.random())] })).toEqual([]);
  });
});
