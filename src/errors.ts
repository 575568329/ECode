// ============================================================
// 结构化错误层（C2 借鉴点④落地）
// ============================================================
// 统一 API 错误类型：status/headers/code 携带，retry / context-manager 用 instanceof 判别，
// 替代裸 `throw new Error` + 反射 `.status` + 字符串匹配 message。
//
// 常量 RETRYABLE_STATUS 放此（底层），retry.ts 从这里 import —— 单一来源，无循环依赖
// （retry → errors 单向；errors 不依赖 retry）。
// ============================================================

export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/** SDK 错误 headers 兼容类型（Headers 实例 / Record，值可 string | string[]） */
export type ApiHeaders = Record<string, string | string[] | undefined> | Headers;

/** 共享基类：retry / 上层用 instanceof ECodeError 统一识别 ECode 错误 */
export class ECodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ECodeError';
  }
}

/**
 * API 调用错误（HTTP status 可知）。retry 用 isRetryable 判是否重试。
 * headers 兼容 SDK 的 Headers 实例 / Record；code 取自 GLM/DeepSeek error body。
 */
export class ECodeAPIError extends ECodeError {
  constructor(
    public status: number,
    message: string,
    public headers?: ApiHeaders,
    public code?: string,
  ) {
    super(message);
    this.name = 'ECodeAPIError';
  }

  get isRetryable(): boolean {
    return RETRYABLE_STATUS.has(this.status);
  }

  /**
   * 大小写无关取 header；值是数组取首元素（兜底 SDK 多值头）。
   * 兼容 Headers 实例（.get）与 Record（遍历 lowercase 匹配）。
   */
  getHeader(name: string): string | undefined {
    const h = this.headers;
    if (!h) return undefined;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      const v = h.get(name);
      return v ?? undefined;
    }
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (k.toLowerCase() === target) {
        if (Array.isArray(v)) return (v[0] as string | undefined) ?? undefined;
        return (v as string | undefined) ?? undefined;
      }
    }
    return undefined;
  }
}

/**
 * 上下文超限错误（业务约束，非「API 调用错误」）。
 * 独立继承 ECodeError（非 ECodeAPIError）—— retry 优先用 instanceof 判它（不可重试），
 * 语义上不附带 isRetryable getter。
 */
export class ContextWindowError extends ECodeError {}

/**
 * 反射判别 SDK 错误是否像 context window 超限。
 * 过渡期字符串/特征兜底，直至 provider 层全链路抛 ContextWindowError。
 *   - OpenAI: code === 'context_length_exceeded'（任意 status）
 *   - Anthropic: status 400 + message 含 context/too long/maximum context
 */
export function looksLikeContextWindowError(err: unknown): boolean {
  if (err instanceof ContextWindowError) return true;
  const anyErr = err as { status?: number; code?: string; message?: string };
  if (anyErr.code === 'context_length_exceeded') return true;
  if (typeof anyErr.message === 'string') {
    const msg = anyErr.message.toLowerCase();
    if (
      anyErr.status === 400 &&
      (msg.includes('context') || msg.includes('too long') || msg.includes('maximum context'))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 把 SDK 抛出的原始错误归一为 ECode 错误（供 withRetry / provider catch 用）。
 *   - 已是 ECodeError → 原样返回（不二次包装）
 *   - 像 context window → ContextWindowError
 *   - 带 status → ECodeAPIError（携 headers/code）
 *   - 无 status（网络错误等）→ 原样返回（retry 不重试）
 */
export function wrapAsECodeError(err: unknown): unknown {
  if (err instanceof ECodeError) return err;
  const anyErr = err as {
    status?: number;
    headers?: ApiHeaders;
    code?: string;
    error?: { code?: string };
    message?: string;
  };
  if (looksLikeContextWindowError(err)) {
    return new ContextWindowError(anyErr.message ?? String(err));
  }
  const status = anyErr.status;
  if (typeof status === 'number') {
    return new ECodeAPIError(
      status,
      anyErr.message ?? String(err),
      anyErr.headers,
      anyErr.code ?? anyErr.error?.code,
    );
  }
  return err;
}
