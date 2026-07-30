import { describe, it, expect, vi } from 'vitest';
import { withRetry, RETRY_CONFIG } from '../src/retry.js';

// 注入空 sleep，避免测试真实等待
const noSleep = async () => {};

describe('withRetry', () => {
  it('成功直接返回，不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('不可重试错误（400）立即抛出，不重试', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(fn, 'test', noSleep)).rejects.toEqual({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误（429）重试到上限后抛', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429 });
    await expect(withRetry(fn, 'test', noSleep)).rejects.toEqual({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(RETRY_CONFIG.MAX_RETRIES + 1); // 1 + 3 次重试
  });

  it('可重试错误中途成功则停止重试', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('无 status 字段的错误立即抛出（当作不可重试）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network'));
    await expect(withRetry(fn, 'test', noSleep)).rejects.toThrow('network');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
