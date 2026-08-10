import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn() }));

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

  // 修「读 config.json 却报错指向 .env」的自相矛盾：config.json 的 providers.glm.apiKey 存值
  // → 全局安装（无 .env 注入、无 env）也能创建 provider。
  it('config.json providers.glm.apiKey 存值 → 无 env 也能创建（全局开箱）', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: { glm: { protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZHIPUAI_API_KEY', apiKey: 'cfg-glm-key', models: { 'glm-5.2': { capabilities: ['tools'] } } } },
      }),
    );
    _resetConfigCacheForTest();
    delete process.env.ZHIPUAI_API_KEY; // 无 env，纯靠 config.json
    const p = createProvider('glm-5.2');
    expect(p.protocol).toBe('openai');
    expect(p.name).toBe('openai');
  });

  // 报错修复：key 全无时，主指引 config.json（不再误导去 .env），但仍含环境变量名作次指引。
  it('key 全无 → 抛错主指引 config.json（不再只指向 .env），仍含变量名', () => {
    vi.mocked(existsSync).mockReturnValue(false); // 默认 config（providers 无 apiKey）
    _resetConfigCacheForTest();
    delete process.env.ZHIPUAI_API_KEY;
    expect(() => createProvider('glm-5.2')).toThrow('config.json'); // 主指引
    expect(() => createProvider('glm-5.2')).toThrow('ZHIPUAI_API_KEY'); // 次指引（变量名）
  });
});
