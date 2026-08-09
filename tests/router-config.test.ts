// 模型路由（支点22）config 读取层测试。
// buildRoutingConfig：把 config.json routing 块解析成 RoutingConfig（纯函数，注入 cfg 避单例）。
import { describe, it, expect } from 'vitest';
import { buildRoutingConfig } from '../src/router/config.js';
import type { ECodeConfig } from '../src/providers/config.js';
import type { ModelConfig } from '../src/providers/types.js';

const glmModel: ModelConfig = { provider: 'zhipuai', capabilities: ['tools'], contextWindow: 128_000 };

const cfg = (over: Partial<ECodeConfig> = {}): ECodeConfig => ({
  defaultModel: 'glm-5.2',
  providers: { zhipuai: { protocol: 'openai', apiKeyEnv: 'ZHIPUAI_API_KEY' } },
  models: { 'glm-5.2': glmModel },
  ...over,
});

describe('buildRoutingConfig', () => {
  it('无 routing 块 → 空 aliases/rules + defaultTarget 从 defaultModel 解析', () => {
    const r = buildRoutingConfig(cfg());
    expect(r.aliases).toEqual({});
    expect(r.rules).toEqual({});
    expect(r.defaultTarget).toEqual({ provider: 'zhipuai', model: 'glm-5.2' });
  });

  it('routing.aliases 透传', () => {
    const r = buildRoutingConfig(
      cfg({
        routing: {
          aliases: { cheap: { provider: 'deepseek', model: 'deepseek-chat' } },
        },
      }),
    );
    expect(r.aliases).toEqual({ cheap: { provider: 'deepseek', model: 'deepseek-chat' } });
  });

  it('routing.rules 透传', () => {
    const r = buildRoutingConfig(
      cfg({ routing: { rules: { compress: 'cheap', subagent: 'strong' } } }),
    );
    expect(r.rules).toEqual({ compress: 'cheap', subagent: 'strong' });
  });

  it('完整 routing（aliases + rules）→ 完整 RoutingConfig', () => {
    const r = buildRoutingConfig(
      cfg({
        routing: {
          aliases: { cheap: { provider: 'deepseek', model: 'deepseek-chat' } },
          rules: { compress: 'cheap' },
        },
      }),
    );
    expect(r.aliases.cheap).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(r.rules.compress).toBe('cheap');
    expect(r.defaultTarget.model).toBe('glm-5.2');
  });

  it('defaultModel 缺失 → defaultTarget 取首个 model 兜底', () => {
    const r = buildRoutingConfig(cfg({ defaultModel: undefined }));
    expect(r.defaultTarget).toEqual({ provider: 'zhipuai', model: 'glm-5.2' });
  });

  it('defaultModel 不在 models → provider 空串降级（不崩）', () => {
    const r = buildRoutingConfig(cfg({ defaultModel: 'ghost' }));
    expect(r.defaultTarget).toEqual({ provider: '', model: 'ghost' });
  });

  it('models 空 → defaultTarget { provider: "", model: "" }（极端兜底）', () => {
    const r = buildRoutingConfig(cfg({ models: {}, defaultModel: undefined }));
    expect(r.defaultTarget).toEqual({ provider: '', model: '' });
  });
});
