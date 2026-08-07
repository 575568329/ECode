import { describe, it, expect } from 'vitest';
import {
  ECodeAPIError,
  ECodeError,
  ContextWindowError,
  RETRYABLE_STATUS,
  wrapAsECodeError,
  looksLikeContextWindowError,
} from '../src/errors.js';

describe('ECodeAPIError.isRetryable', () => {
  it('可重试 status (408/429/500/502/503/504/529) 返回 true', () => {
    [408, 429, 500, 502, 503, 504, 529].forEach((s) => {
      expect(new ECodeAPIError(s, 'x').isRetryable).toBe(true);
    });
  });

  it('不可重试 status (400/401/403/404) 返回 false', () => {
    [400, 401, 403, 404].forEach((s) => {
      expect(new ECodeAPIError(s, 'x').isRetryable).toBe(false);
    });
  });

  it('携带 status / headers / code', () => {
    const e = new ECodeAPIError(429, 'rate limit', { 'retry-after': '5' }, 'rate_limit');
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limit');
    expect(e.headers).toBeDefined();
  });
});

describe('ECodeAPIError.getHeader（大小写无关 + 数组兜底）', () => {
  it('Record: 大小写无关取值', () => {
    const e = new ECodeAPIError(429, 'x', { 'Retry-After': '5' });
    expect(e.getHeader('retry-after')).toBe('5');
  });

  it('数组值取首元素（兜底 SDK 多值头）', () => {
    const e = new ECodeAPIError(429, 'x', { 'retry-after': ['5', '10'] });
    expect(e.getHeader('retry-after')).toBe('5');
  });

  it('无 headers 返回 undefined', () => {
    expect(new ECodeAPIError(429, 'x').getHeader('retry-after')).toBeUndefined();
  });

  it('缺失 header 返回 undefined', () => {
    const e = new ECodeAPIError(429, 'x', { other: '1' });
    expect(e.getHeader('retry-after')).toBeUndefined();
  });

  it('Headers 实例取值', () => {
    const h = new Headers();
    h.set('retry-after', '7');
    const e = new ECodeAPIError(429, 'x', h);
    expect(e.getHeader('retry-after')).toBe('7');
  });
});

describe('ContextWindowError 继承关系', () => {
  it('继承 ECodeError 但非 ECodeAPIError（业务约束，无 isRetryable）', () => {
    const e = new ContextWindowError('too long');
    expect(e).toBeInstanceOf(ECodeError);
    expect(e).not.toBeInstanceOf(ECodeAPIError);
    expect((e as unknown as { isRetryable?: unknown }).isRetryable).toBeUndefined();
  });
});

describe('wrapAsECodeError（SDK 错误归一）', () => {
  it('SDK 错误（带 status + headers）→ ECodeAPIError', () => {
    const sdk = Object.assign(new Error('boom'), {
      status: 429,
      headers: { 'retry-after': '5' },
    });
    const wrapped = wrapAsECodeError(sdk) as ECodeAPIError;
    expect(wrapped).toBeInstanceOf(ECodeAPIError);
    expect(wrapped.status).toBe(429);
    expect(wrapped.getHeader('retry-after')).toBe('5');
  });

  it('SDK 错误携 error.body.code → 提取到 code', () => {
    const sdk = Object.assign(new Error('boom'), {
      status: 429,
      error: { code: 'rate_limit_exceeded' },
    });
    const wrapped = wrapAsECodeError(sdk) as ECodeAPIError;
    expect(wrapped.code).toBe('rate_limit_exceeded');
  });

  it('Anthropic 400 + context 关键词 → ContextWindowError', () => {
    const sdk = Object.assign(new Error('prompt is too long: 10000 tokens > 8192 maximum'), {
      status: 400,
    });
    expect(wrapAsECodeError(sdk)).toBeInstanceOf(ContextWindowError);
  });

  it('OpenAI context_length_exceeded code → ContextWindowError', () => {
    const sdk = Object.assign(new Error("This model's maximum context length is..."), {
      status: 400,
      code: 'context_length_exceeded',
    });
    expect(wrapAsECodeError(sdk)).toBeInstanceOf(ContextWindowError);
  });

  it('已是 ECodeError → 原样返回（不二次包装）', () => {
    const e = new ECodeAPIError(500, 'x');
    expect(wrapAsECodeError(e)).toBe(e);
  });

  it('无 status 的非 API 错误 → 原样返回（网络错误不重试）', () => {
    const e = new Error('network down');
    expect(wrapAsECodeError(e)).toBe(e);
  });
});

describe('looksLikeContextWindowError', () => {
  it('400 + context 关键词 → true', () => {
    expect(
      looksLikeContextWindowError(Object.assign(new Error('context window exceeded'), { status: 400 })),
    ).toBe(true);
  });

  it('400 无关键词 → false', () => {
    expect(
      looksLikeContextWindowError(Object.assign(new Error('bad request'), { status: 400 })),
    ).toBe(false);
  });

  it('429（可重试）不是 context window', () => {
    expect(
      looksLikeContextWindowError(Object.assign(new Error('rate limited'), { status: 429 })),
    ).toBe(false);
  });

  it('OpenAI code context_length_exceeded → true', () => {
    expect(
      looksLikeContextWindowError(Object.assign(new Error('x'), { code: 'context_length_exceeded' })),
    ).toBe(true);
  });
});

describe('RETRYABLE_STATUS 单一来源', () => {
  it('包含可重试码', () => {
    [408, 425, 429, 500, 502, 503, 504, 529].forEach((s) =>
      expect(RETRYABLE_STATUS.has(s)).toBe(true),
    );
  });

  it('不含客户端错误码', () => {
    [400, 401, 403, 404].forEach((s) => expect(RETRYABLE_STATUS.has(s)).toBe(false));
  });
});
