import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/system-prompt.js';

describe('buildSystemPrompt', () => {
  it('返回非空字符串', () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('含身份标识 ECode（模型认知正确，不再自称 Claude）', () => {
    expect(buildSystemPrompt()).toContain('ECode');
  });

  it('包含行为准则与诚实报告约束', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('行为准则');
    expect(prompt).toContain('诚实报告');
  });

  it('传入 instructions 时拼入项目记忆段', () => {
    const prompt = buildSystemPrompt('## 项目记忆\n禁止用 any');
    expect(prompt).toContain('项目记忆');
    expect(prompt).toContain('禁止用 any');
  });

  it('不传 instructions 时不含项目记忆段（向后兼容）', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain('项目记忆');
  });
});
