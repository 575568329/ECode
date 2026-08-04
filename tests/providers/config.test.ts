import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import {
  getDefaultModel,
  getModelConfig,
  getProviderConfig,
  hasCapability,
  listAvailableModels,
  resolveBaseURL,
  _resetConfigCacheForTest,
} from '../../src/providers/config.js';

describe('config（默认配置，文件不存在）', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    _resetConfigCacheForTest();
  });

  it('默认模型 + 能力查询', () => {
    expect(getDefaultModel()).toBe('glm-5.2');
    expect(hasCapability('glm-5.2', 'tools')).toBe(true);
    expect(hasCapability('glm-5.2', 'vision')).toBe(false);
  });

  it('未知模型抛错并列出可用', () => {
    expect(() => getModelConfig('xxx')).toThrow('未知模型');
    expect(() => getModelConfig('xxx')).toThrow('glm-5.2');
  });

  it('列出可用模型', () => {
    const models = listAvailableModels().map((m) => m.model);
    expect(models).toContain('glm-5.2');
    expect(models).toContain('deepseek-chat');
  });

  // GLM 默认走 coding plan 端点（对齐 CCode 源码 config-manager.ts:53）
  // coding plan 套餐专用端点含 /coding/，普通 paas/v4 会因套餐不匹配报 429
  it('GLM 默认走 coding plan 端点 + 暴露 GLM_BASE_URL 覆盖入口', () => {
    const glm = getProviderConfig('glm');
    expect(glm.baseURL).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(glm.baseURLEnv).toBe('GLM_BASE_URL');
  });

  it('各 provider 均暴露厂商专属 baseURLEnv（与 apiKeyEnv 对称）', () => {
    expect(getProviderConfig('deepseek').baseURLEnv).toBe('DEEPSEEK_BASE_URL');
    expect(getProviderConfig('claude').baseURLEnv).toBe('ANTHROPIC_BASE_URL');
  });
});

describe('config（读取文件）', () => {
  beforeEach(() => {
    _resetConfigCacheForTest();
  });

  it('文件存在时用文件配置', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'custom-model',
        providers: { x: { protocol: 'openai', apiKeyEnv: 'X_KEY' } },
        models: { 'custom-model': { provider: 'x', capabilities: [] } },
      }),
    );
    expect(getDefaultModel()).toBe('custom-model');
    expect(hasCapability('custom-model', 'tools')).toBe(false);
  });

  it('文件解析失败降级默认配置', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ 不是合法 json');
    expect(getDefaultModel()).toBe('glm-5.2');
  });
});

// resolveBaseURL：baseURL 三级优先级解析（env > config.json > 内置默认/undefined）
// 抽成纯函数便于单测，避免为验证解析逻辑而实例化 SDK（关注点分离）
describe('resolveBaseURL（env > config > 内置 三级优先级）', () => {
  beforeEach(() => {
    delete process.env.GLM_BASE_URL;
  });

  it('env 有值 → 覆盖 config.baseURL（.env 灵活切换代理/端点）', () => {
    process.env.GLM_BASE_URL = 'https://my-proxy.com/v1';
    const url = resolveBaseURL({
      protocol: 'openai',
      baseURL: 'https://default.com',
      apiKeyEnv: 'K',
      baseURLEnv: 'GLM_BASE_URL',
    });
    expect(url).toBe('https://my-proxy.com/v1');
  });

  it('env 未设 → 回退 config.baseURL', () => {
    const url = resolveBaseURL({
      protocol: 'openai',
      baseURL: 'https://default.com',
      apiKeyEnv: 'K',
      baseURLEnv: 'GLM_BASE_URL',
    });
    expect(url).toBe('https://default.com');
  });

  it('env 为空字符串 → 视为未设置，回退 config.baseURL（.env 里留空=用默认）', () => {
    process.env.GLM_BASE_URL = '';
    const url = resolveBaseURL({
      protocol: 'openai',
      baseURL: 'https://default.com',
      apiKeyEnv: 'K',
      baseURLEnv: 'GLM_BASE_URL',
    });
    expect(url).toBe('https://default.com');
  });

  it('baseURLEnv 未配但 baseURL 有值 → 用 config.baseURL（兼容旧配置/无 env 覆盖需求的 provider）', () => {
    const url = resolveBaseURL({ protocol: 'openai', baseURL: 'https://cfg.com', apiKeyEnv: 'K' });
    expect(url).toBe('https://cfg.com');
  });

  it('baseURLEnv 与 baseURL 都没有 → 返回 undefined（不传 SDK，交其走协议默认地址）', () => {
    const url = resolveBaseURL({ protocol: 'openai', apiKeyEnv: 'K' });
    expect(url).toBeUndefined();
  });
});
