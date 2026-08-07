import { describe, it, expect, vi } from 'vitest';
import { withRetry, RETRY_CONFIG } from '../src/retry.js';
import { ECodeAPIError, ContextWindowError } from '../src/errors.js';

// 注入空 sleep，避免测试真实等待
const noSleep = async () => {};

describe('withRetry', () => {
  it('成功直接返回，不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('不可重试错误（400）→ ECodeAPIError 立即抛，只调一次', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }));
    const rejected = await withRetry(fn, 'test', noSleep).catch((e) => e);
    expect(rejected).toBeInstanceOf(ECodeAPIError);
    expect((rejected as ECodeAPIError).status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误（429）重试到上限后抛 ECodeAPIError', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    const rejected = await withRetry(fn, 'test', noSleep).catch((e) => e);
    expect(rejected).toBeInstanceOf(ECodeAPIError);
    expect(fn).toHaveBeenCalledTimes(RETRY_CONFIG.MAX_RETRIES + 1); // 1 + 3 次重试
  });

  it('可重试错误中途成功则停止重试', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('a'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('b'), { status: 503 }))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('无 status 字段的错误立即抛出（当作不可重试）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network'));
    await expect(withRetry(fn, 'test', noSleep)).rejects.toThrow('network');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('context window 错误（400 + context）→ ContextWindowError 立即抛，不重试', async () => {
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error('prompt is too long: context exceeded'), { status: 400 }),
    );
    const rejected = await withRetry(fn, 'test', noSleep).catch((e) => e);
    expect(rejected).toBeInstanceOf(ContextWindowError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('OpenAI context_length_exceeded → ContextWindowError（不重试）', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("maximum context length"), { status: 400, code: 'context_length_exceeded' }),
      );
    const rejected = await withRetry(fn, 'test', noSleep).catch((e) => e);
    expect(rejected).toBeInstanceOf(ContextWindowError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry 读 Retry-After', () => {
  it('429 + Retry-After:5 → delay≈5000ms（优先于指数退避）', async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    const fn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '5' } }));
    await withRetry(fn, 'test', sleepFn).catch(() => {});
    expect(sleeps[0]).toBe(5000);
  });

  it('429 + Retry-After:0.5（小数秒）→ delay≈500ms', async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    const fn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '0.5' } }));
    await withRetry(fn, 'test', sleepFn).catch(() => {});
    expect(sleeps[0]).toBe(500);
  });

  it('无 Retry-After → 指数退避（base * 2^attempt + jitter）', async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    await withRetry(fn, 'test', sleepFn).catch(() => {});
    // attempt=0 → base*1 + jitter ∈ [1000, 1500)
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThan(1500);
    // attempt=1 → base*2 + jitter ∈ [2000, 2500)
    expect(sleeps[1]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[1]).toBeLessThan(2500);
  });

  it('Retry-After 大小写无关（SDK header 大写）', async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    const fn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('rate'), { status: 429, headers: { 'Retry-After': '3' } }));
    await withRetry(fn, 'test', sleepFn).catch(() => {});
    expect(sleeps[0]).toBe(3000);
  });
});
