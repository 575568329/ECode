import { describe, it, expect, vi, beforeEach } from 'vitest';

// config.json 旧格式（顶层 models）→ 新格式（providers.*.models）自动迁移测试。
// migrateConfig / validateModelUniqueness 是私有函数，通过 loadConfig 间接观察行为：
//   1. 读旧格式 → 搬运到对应 provider.models + 原子写回（tmp + rename）
//   2. 已嵌套 models → 幂等跳过（不写回）
//   3. 模型指向不存在的 provider / 缺 provider 字段 → 跳过该模型（不崩）
//   4. 多 provider 同名模型 → 抛错拒绝启动（全局唯一校验，不静默降级）
//   5. defaultModel 指向不存在模型 → 软降级（置空 + 回退首个可用）
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import {
  _resetConfigCacheForTest,
  getModelConfig,
  getDefaultModel,
  listAvailableModels,
} from '../../src/providers/config.js';

describe('migrateConfig（顶层 models → providers.*.models 自动迁移）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    _resetConfigCacheForTest();
  });

  it('旧格式（顶层 models + .provider 字段）→ 搬运到对应 provider 并原子写回', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: {
          glm: { protocol: 'openai', apiKeyEnv: 'ZHIPUAI_API_KEY' },
          deepseek: { protocol: 'openai', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        },
        models: {
          'glm-5.2': { provider: 'glm', capabilities: ['tools'], contextWindow: 1_000_000 },
          'deepseek-chat': { provider: 'deepseek', capabilities: ['tools'], contextWindow: 128_000 },
        },
      }),
    );

    // getModelConfig 触发 loadConfig → migrateConfig 搬运
    const glm = getModelConfig('glm-5.2');
    expect(glm.providerKey).toBe('glm');
    expect(glm.config.capabilities).toEqual(['tools']);
    expect(glm.config.contextWindow).toBe(1_000_000);

    const ds = getModelConfig('deepseek-chat');
    expect(ds.providerKey).toBe('deepseek');

    // 原子写回：writeFileSync 写 tmp + renameSync 原子替换
    expect(writeFileSync).toHaveBeenCalledOnce();
    expect(renameSync).toHaveBeenCalledOnce();
    // 写回内容：旧 .provider 字段已剥离 + 模型名仍在（嵌套位置）
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(written).not.toContain('"provider": "glm"'); // .provider 字段已剔除（provider 由嵌套位置隐含）
    expect(written).toContain('glm-5.2');
    expect(written).toContain('deepseek-chat');
  });

  it('已嵌套 models（新格式）→ 幂等，不触发迁移写回', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: {
          glm: {
            protocol: 'openai',
            apiKeyEnv: 'ZHIPUAI_API_KEY',
            models: { 'glm-5.2': { capabilities: ['tools'] } },
          },
        },
      }),
    );

    getModelConfig('glm-5.2'); // 触发 loadConfig（已迁移格式，应跳过）
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it('模型指向不存在的 provider → 跳过该模型（不崩）', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: { glm: { protocol: 'openai', apiKeyEnv: 'ZHIPUAI_API_KEY' } },
        models: {
          'glm-5.2': { provider: 'glm', capabilities: ['tools'] },
          orphan: { provider: 'ghost', capabilities: ['tools'] }, // ghost provider 不存在
        },
      }),
    );

    getModelConfig('glm-5.2'); // 正常模型可用
    expect(() => getModelConfig('orphan')).toThrow('未知模型'); // 孤儿模型被跳过
  });

  it('模型缺少 provider 字段 → 跳过该模型', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: { glm: { protocol: 'openai', apiKeyEnv: 'ZHIPUAI_API_KEY' } },
        models: {
          'glm-5.2': { provider: 'glm', capabilities: ['tools'] },
          'no-provider': { capabilities: ['tools'] }, // 缺 provider 字段
        },
      }),
    );

    getModelConfig('glm-5.2');
    expect(() => getModelConfig('no-provider')).toThrow('未知模型');
  });
});

describe('validateModelUniqueness（模型全局唯一校验）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    _resetConfigCacheForTest();
  });

  // 重复模型属严重配置错误：抛错拒绝启动，而不是静默降级到默认（降级会掩盖问题）。
  it('多 provider 同名模型 → loadConfig 抛错拒绝启动（不静默降级）', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'dup',
        providers: {
          glm: { protocol: 'openai', apiKeyEnv: 'A', models: { dup: { capabilities: ['tools'] } } },
          deepseek: { protocol: 'openai', apiKeyEnv: 'B', models: { dup: { capabilities: ['tools'] } } },
        },
      }),
    );

    expect(() => getModelConfig('dup')).toThrow('重复定义');
  });

  it('defaultModel 指向不存在模型 → 软降级，getDefaultModel 回退首个可用', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'ghost', // 不在任何 provider 中
        providers: {
          glm: {
            protocol: 'openai',
            apiKeyEnv: 'ZHIPUAI_API_KEY',
            models: { 'glm-5.2': { capabilities: ['tools'] } },
          },
        },
      }),
    );

    // loadConfig 不抛错（defaultModel 软降级），getDefaultModel 回退首个可用
    expect(getDefaultModel()).toBe('glm-5.2');
    expect(listAvailableModels().map((m) => m.model)).toContain('glm-5.2');
  });
});
