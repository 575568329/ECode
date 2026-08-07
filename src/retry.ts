// API 调用重试：对可重试 HTTP 状态码（429/5xx 等）指数退避 + jitter 重试，
// 不可重试错误（400/401 等）立即抛出。优先读 Retry-After header 决定等待时长。

import { ECodeAPIError, ContextWindowError, RETRYABLE_STATUS, wrapAsECodeError } from './errors.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带重试执行 async 函数。
 * - 可重试错误（429/5xx/529 等）：优先 Retry-After header，否则指数退避（base * 2^attempt）+ jitter
 * - 不可重试错误（400/401/403 等）或 context window 错误：立即抛出（结构化为 ECodeAPIError / ContextWindowError）
 * - sleepFn 可注入，便于测试（测试传记录函数验证 delay）
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
      const ecodeErr = wrapAsECodeError(err);
      // context window 超限：业务约束，不可重试
      if (ecodeErr instanceof ContextWindowError) throw ecodeErr;
      if (ecodeErr instanceof ECodeAPIError) {
        if (!ecodeErr.isRetryable) throw ecodeErr;
        if (attempt === MAX_RETRIES) {
          lastErr = ecodeErr;
          break;
        }
        const delay = computeDelay(ecodeErr, attempt);
        console.error(
          `⚠️  [${source}] HTTP ${ecodeErr.status}，${(delay / 1000).toFixed(1)}s 后重试（第 ${attempt + 1}/${MAX_RETRIES} 次）`,
        );
        await sleepFn(delay);
      } else {
        // 非 API 错误（无 status，如网络错误）→ 不重试，原样抛
        throw err;
      }
    }
  }
  throw lastErr;
}

/** 优先 Retry-After header（delta-seconds 或 HTTP-date），否则指数退避 + jitter */
function computeDelay(err: ECodeAPIError, attempt: number): number {
  const retryAfter = err.getHeader('retry-after');
  if (retryAfter) {
    const ms = parseRetryAfterMs(retryAfter);
    if (ms !== undefined) return ms;
  }
  return BASE_DELAY_MS * 2 ** attempt + Math.random() * JITTER_MS;
}

/**
 * 解析 Retry-After（RFC 7231）：delta-seconds 或 HTTP-date。
 * - parseFloat 防小数、Number.isFinite 校验、负值忽略
 * - HTTP-date（Date.parse）兜底，取 max(0, date - now)
 */
function parseRetryAfterMs(value: string): number | undefined {
  const num = Number.parseFloat(value);
  if (Number.isFinite(num) && num >= 0) return num * 1000; // delta-seconds
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now()); // HTTP-date
  return undefined;
}

export const RETRY_CONFIG = { MAX_RETRIES, RETRYABLE_STATUS };
