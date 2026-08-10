import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import {
  getDefaultModel,
  getModelConfig,
  getProviderConfig,
  getContextWindow,
  hasCapability,
  listAvailableModels,
  resolveBaseURL,
  resolveApiKey,
  isValidationEnabled,
  _resetConfigCacheForTest,
} from '../../src/providers/config.js';

describe('config（默认配置，文件不存在）', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(mkdirSync).mockClear();
    _resetConfigCacheForTest();
  });

  it('默认模型 + 能力查询', () => {
    expect(getDefaultModel()).toBe('glm-5.2');
    expect(hasCapability('glm-5.2', 'tools')).toBe(true);
    expect(hasCapability('glm-5.2', 'vision')).toBe(false);
  });

  it('首次加载触发配置模板生成（writeFileSync + mkdirSync）', () => {
    getDefaultModel(); // 触发 loadConfig
    expect(mkdirSync).toHaveBeenCalledOnce();
    expect(writeFileSync).toHaveBeenCalledOnce();
    // 写入的内容应包含 // 注释行 + JSON 主体
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain('// ECode 用户配置');
    expect(written).toContain('glm-5.2');
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

  // P0-5 后置验证开关：默认 false（对齐 Aider auto-test，避免每次写文件阻塞验证拖慢）
  it('后置验证默认关闭（DEFAULT_CONFIG validation.enabled=false）', () => {
    expect(isValidationEnabled()).toBe(false);
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

  // P0-5：用户在 config.json 设 validation.enabled=false → 关闭后置验证
  it('validation.enabled=false → isValidationEnabled 返回 false', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: {},
        models: {},
        validation: { enabled: false },
      }),
    );
    expect(isValidationEnabled()).toBe(false);
  });

  // P0-5：用户在 config.json 设 validation.enabled=true → 开启后置验证（开启路径）
  it('validation.enabled=true → isValidationEnabled 返回 true', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        defaultModel: 'glm-5.2',
        providers: {},
        models: {},
        validation: { enabled: true },
      }),
    );
    expect(isValidationEnabled()).toBe(true);
  });

  // 真实 ~/.ecode/config.json 由 writeConfigTemplate 自动生成，带 // 注释头。
  // 验证 loadConfig 的注释 strip 逻辑能正确解析它，并读出文件里的模型 + 阈值
  // （上下文压缩 isOverThreshold 依赖 getContextWindow 取窗口大小）。
  //
  // 关键：mock 文件里 glm-5.2 的 contextWindow 故意写成 500_000（区别于默认 1m）。
  // 这样只有「注释被 strip + 文件被真正解析」才会拿到 500k；
  // 若 strip 缺失/失败 → JSON.parse 抛错 → 降级 DEFAULT_CONFIG → 拿到 1m → 测试失败。
  // 即本测试能真正 catch「带注释 config 读不出」的回归。
  it('带 // 注释的 config.json 能被正确解析（注释 strip 生效，读出文件真实值）', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    // 镜像真实文件结构：注释头 + JSON 主体（contextWindow 用区别于默认的 500_000）
    vi.mocked(readFileSync).mockReturnValue(
      [
        '// ECode 用户配置（首次启动自动生成）',
        '// API Key 通过环境变量注入，不要在此文件明文填写密钥。',
        '// 添加自定义模型：见文档',
        JSON.stringify({
          defaultModel: 'glm-5.2',
          providers: { glm: { protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZHIPUAI_API_KEY' } },
          models: { 'glm-5.2': { provider: 'glm', capabilities: ['tools'], contextWindow: 500_000 } },
        }),
      ].join('\n'),
    );
    // 默认模型从文件读出（非降级）
    expect(getDefaultModel()).toBe('glm-5.2');
    // 500k 证明确实是读文件（降级会给 1m）→ 注释 strip 生效
    expect(getContextWindow('glm-5.2')).toBe(500_000);
    // 未配置的模型仍回退默认 128K（getContextWindow 的兜底）
    expect(getContextWindow('unknown-model')).toBe(128_000);
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

// resolveApiKey：key 两级优先级解析（env > config.json.apiKey），与 resolveBaseURL 对称。
// 修「读 config.json 却报错指向 .env」的自相矛盾：key 也能从 config.json 直接存值，
// 全局安装（无 .env 注入）靠 config.apiKey 自给；env 仅作临时覆盖（开发/CI 切 key 不改 config）。
describe('resolveApiKey（env > config.apiKey 两级优先级，对称 resolveBaseURL）', () => {
  const KEY_ENV = 'ECODE_TEST_MOCK_KEY';
  beforeEach(() => {
    delete process.env[KEY_ENV];
  });

  it('env 有值 → 覆盖 config.apiKey（开发 .env / CI 临时切 key 不改 config）', () => {
    process.env[KEY_ENV] = 'env-key';
    const key = resolveApiKey({ protocol: 'openai', apiKeyEnv: KEY_ENV, apiKey: 'cfg-key' });
    expect(key).toBe('env-key');
  });

  it('env 未设 → 回退 config.apiKey（全局安装无 .env 注入，靠 config.json 自给）', () => {
    const key = resolveApiKey({ protocol: 'openai', apiKeyEnv: KEY_ENV, apiKey: 'cfg-key' });
    expect(key).toBe('cfg-key');
  });

  it('env 为空字符串 → 视为未设置，回退 config.apiKey', () => {
    process.env[KEY_ENV] = '';
    const key = resolveApiKey({ protocol: 'openai', apiKeyEnv: KEY_ENV, apiKey: 'cfg-key' });
    expect(key).toBe('cfg-key');
  });

  it('env 与 config.apiKey 都没有 → 返回 undefined（factory 层抛错）', () => {
    const key = resolveApiKey({ protocol: 'openai', apiKeyEnv: KEY_ENV });
    expect(key).toBeUndefined();
  });

  it('向后兼容：旧配置无 apiKey 字段、仅靠 env → env 路径不变', () => {
    process.env[KEY_ENV] = 'env-only';
    const key = resolveApiKey({ protocol: 'openai', apiKeyEnv: KEY_ENV });
    expect(key).toBe('env-only');
  });
});
