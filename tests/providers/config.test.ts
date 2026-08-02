import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import {
  getDefaultModel,
  getModelConfig,
  hasCapability,
  listAvailableModels,
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
