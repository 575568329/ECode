// API 调用重试：对可重试 HTTP 状态码（429/5xx 等）指数退避 + jitter 重试，
// 不可重试错误（400/401 等）立即抛出。

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function getHttpStatus(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

/**
 * 带重试执行 async 函数。
 * - 可重试错误（429/5xx/529 等）：指数退避（base * 2^attempt）+ 随机 jitter 重试
 * - 不可重试错误（400/401/403 等）：立即抛出
 * - sleepFn 可注入，便于测试（测试传空函数避免真实等待）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  source: string,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = getHttpStatus(err);
      if (!status || !RETRYABLE_STATUS.has(status)) throw err;
      if (attempt === MAX_RETRIES) break;
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * JITTER_MS;
      console.error(
        `⚠️  [${source}] HTTP ${status}，${(delay / 1000).toFixed(1)}s 后重试（第 ${attempt + 1}/${MAX_RETRIES} 次）`,
      );
      await sleepFn(delay);
    }
  }
  throw lastErr;
}

export const RETRY_CONFIG = { MAX_RETRIES, RETRYABLE_STATUS };
