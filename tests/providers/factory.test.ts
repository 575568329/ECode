import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

import { createProvider } from '../../src/providers/factory.js';
import { _resetConfigCacheForTest } from '../../src/providers/config.js';

describe('createProvider', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false); // 用默认 config
    _resetConfigCacheForTest();
    delete process.env.ZHIPUAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('glm（openai 协议）→ OpenAIProvider', () => {
    process.env.ZHIPUAI_API_KEY = 'fake-glm';
    const p = createProvider('glm-5.2');
    expect(p.protocol).toBe('openai');
    expect(p.name).toBe('openai');
  });

  it('缺环境变量时抛错并指明缺哪个', () => {
    expect(() => createProvider('glm-5.2')).toThrow('ZHIPUAI_API_KEY');
  });

  it('未知 model 抛错（config 层）', () => {
    process.env.ZHIPUAI_API_KEY = 'fake';
    expect(() => createProvider('not-exist')).toThrow('未知模型');
  });
});
