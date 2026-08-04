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
    delete process.env.GLM_BASE_URL;
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

  // baseURL 解析端到端：env（GLM_BASE_URL）> config.json（baseURL）> 内置默认（coding 端点）
  // provider.baseURL 取自 SDK 实际值，验证整条链路（resolveBaseURL → 构造 → SDK getter）
  it('baseURL：无 env 时用内置 coding plan 端点', () => {
    process.env.ZHIPUAI_API_KEY = 'fake';
    const p = createProvider('glm-5.2');
    expect(p.baseURL).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
  });

  it('baseURL：GLM_BASE_URL 覆盖内置默认', () => {
    process.env.ZHIPUAI_API_KEY = 'fake';
    process.env.GLM_BASE_URL = 'https://my-proxy/v1';
    const p = createProvider('glm-5.2');
    expect(p.baseURL).toBe('https://my-proxy/v1');
  });
});
