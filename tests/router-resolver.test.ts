import { describe, it, expect } from 'vitest';
import { resolveAlias } from '../src/router/resolver.js';
import type { AliasTarget } from '../src/router/types.js';

describe('resolveAlias', () => {
  const aliases: Record<string, AliasTarget> = {
    cheap: { provider: 'deepseek', model: 'deepseek-chat' },
    strong: { provider: 'zhipuai', model: 'glm-4.6' },
  };
  const fallback: AliasTarget = { provider: 'zhipuai', model: 'glm-5.2' };

  it('已配置的 alias 返回其映射落点', () => {
    expect(resolveAlias('cheap', aliases, fallback)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('已配置的不同 alias 返回各自落点（不串）', () => {
    expect(resolveAlias('strong', aliases, fallback)).toEqual({
      provider: 'zhipuai',
      model: 'glm-4.6',
    });
  });

  it('未配置的 alias 回退 fallback（不抛错，降级用默认模型）', () => {
    expect(resolveAlias('reasoning', aliases, fallback)).toEqual(fallback);
  });

  it('空 aliases 表时任意 alias 回退 fallback', () => {
    expect(resolveAlias('cheap', {}, fallback)).toEqual(fallback);
  });

  it('自定义 alias 字符串同样查表（ModelAlias 允许 string & {} 扩展）', () => {
    const custom: Record<string, AliasTarget> = {
      'my-model': { provider: 'custom', model: 'y' },
    };
    expect(resolveAlias('my-model', custom, fallback)).toEqual({
      provider: 'custom',
      model: 'y',
    });
  });

  it('命中的落点保持原对象引用语义（返回的是表中的值，非 fallback）', () => {
    expect(resolveAlias('cheap', aliases, fallback)).toBe(aliases.cheap);
  });
});
