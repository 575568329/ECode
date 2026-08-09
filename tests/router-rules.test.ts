// 模型路由（支点22）rules 纯函数测试。
// resolveModelForScenario：优先级 显式 frontmatter model > 场景规则 > global default。
import { describe, it, expect } from 'vitest';
import { resolveModelForScenario, type RoutingConfig } from '../src/router/rules.js';

const cfg = (over: Partial<RoutingConfig> = {}): RoutingConfig => ({
  aliases: {
    cheap: { provider: 'deepseek', model: 'deepseek-chat' },
    strong: { provider: 'zhipuai', model: 'glm-4.6' },
  },
  rules: { compress: 'cheap', subagent: 'strong' },
  defaultTarget: { provider: 'zhipuai', model: 'glm-5.2' },
  ...over,
});

describe('resolveModelForScenario', () => {
  it('场景规则命中 → alias 解析（compress 派 cheap）', () => {
    expect(resolveModelForScenario('compress', undefined, cfg())).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('显式 frontmatter model > 场景规则（subagent agentModel=cheap 覆盖规则 strong）', () => {
    expect(resolveModelForScenario('subagent', { agentModel: 'cheap' }, cfg()).model).toBe(
      'deepseek-chat',
    );
  });

  it('skill 场景显式 skillModel 生效', () => {
    expect(resolveModelForScenario('skill', { skillModel: 'strong' }, cfg()).model).toBe('glm-4.6');
  });

  it('显式 model 仅对应场景生效（compress 忽略 skillModel → 走规则 cheap）', () => {
    expect(resolveModelForScenario('compress', { skillModel: 'strong' }, cfg()).model).toBe(
      'deepseek-chat',
    );
  });

  it('global 场景恒走 default（无显式无规则）', () => {
    expect(resolveModelForScenario('global', undefined, cfg())).toEqual({
      provider: 'zhipuai',
      model: 'glm-5.2',
    });
  });

  it('规则指向未配置 alias → 回退 default（不崩）', () => {
    expect(resolveModelForScenario('compress', undefined, cfg({ aliases: {} }))).toEqual({
      provider: 'zhipuai',
      model: 'glm-5.2',
    });
  });

  it('显式 model 指向未配置 alias → 回退 default', () => {
    expect(
      resolveModelForScenario('subagent', { agentModel: 'nonexistent' }, cfg({ aliases: {} })).model,
    ).toBe('glm-5.2');
  });

  it('空规则表 → 无显式时全走 default', () => {
    expect(resolveModelForScenario('subagent', undefined, cfg({ rules: {} }))).toEqual({
      provider: 'zhipuai',
      model: 'glm-5.2',
    });
  });
});
