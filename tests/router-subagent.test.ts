import { describe, it, expect } from 'vitest';
// resolveModelForSubagent：子代理路由纯函数（R3）。complexity 分支 + 跨 provider 解耦 + source 返回。
// 不改 resolveModelForScenario（向后兼容其他场景），仅 subagent 用本函数。
import { resolveModelForSubagent } from '../src/router/rules.js';
import type { RoutingConfig } from '../src/router/rules.js';

const config: RoutingConfig = {
  aliases: {
    cheap: { provider: 'deepseek', model: 'deepseek-chat' },
    strong: { provider: 'zhipu', model: 'glm-4.6' },
    reasoning: { provider: 'zhipu', model: 'glm-5.2' },
  },
  rules: { subagent: 'strong' },
  defaultTarget: { provider: 'zhipu', model: 'glm-5.2' },
  complexityRouting: false,
  complexity: { simple: 'cheap', medium: 'strong', complex: 'reasoning' },
};

describe('resolveModelForSubagent', () => {
  it('persona 显式优先 → source=persona，跨 provider 取落点（cheap→deepseek）', () => {
    const r = resolveModelForSubagent({ personaModel: 'cheap', taskDesc: '查找符号' }, config);
    expect(r).toEqual({ provider: 'deepseek', model: 'deepseek-chat', source: 'persona' });
  });

  it('complexityRouting=true + medium 任务 → complexity 档（strong）', () => {
    const r = resolveModelForSubagent({ taskDesc: 'rename the architecture' }, { ...config, complexityRouting: true });
    expect(r.source).toBe('complexity');
    expect(r.model).toBe('glm-4.6');
  });

  it('complexityRouting=true + complex 任务 → reasoning', () => {
    const r = resolveModelForSubagent({ taskDesc: '重构整个模块' }, { ...config, complexityRouting: true });
    expect(r.source).toBe('complexity');
    expect(r.model).toBe('glm-5.2');
  });

  it('complexityRouting=true + simple 任务 → cheap（跨 provider deepseek）', () => {
    const r = resolveModelForSubagent({ taskDesc: '修复错别字' }, { ...config, complexityRouting: true });
    expect(r.source).toBe('complexity');
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-chat');
  });

  it('complexityRouting=true 但该档 complexity 缺失 → 退 rules.subagent', () => {
    const cfg2: RoutingConfig = { ...config, complexityRouting: true, complexity: { medium: 'strong' } };
    const r = resolveModelForSubagent({ taskDesc: '重构整个模块' }, cfg2); // complex 档缺失
    expect(r.source).toBe('rule');
    expect(r.model).toBe('glm-4.6'); // rules.subagent=strong
  });

  it('complexityRouting=false → 退 rules.subagent（向后兼容，行为不变）', () => {
    const r = resolveModelForSubagent({ taskDesc: '重构整个模块' }, config);
    expect(r.source).toBe('rule');
    expect(r.model).toBe('glm-4.6');
  });

  it('无 rules.subagent + complexityRouting=false → default', () => {
    const cfg2: RoutingConfig = { ...config, rules: {} };
    const r = resolveModelForSubagent({ taskDesc: '随便看看' }, cfg2);
    expect(r.source).toBe('default');
    expect(r.model).toBe('glm-5.2');
  });

  it('persona 优先于 complexityRouting（即使开启复杂度路由）', () => {
    const r = resolveModelForSubagent({ personaModel: 'reasoning', taskDesc: '修复错别字' }, { ...config, complexityRouting: true });
    expect(r.source).toBe('persona');
    expect(r.model).toBe('glm-5.2');
  });
});
