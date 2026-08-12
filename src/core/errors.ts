/**
 * 错误归一化：把任意异常翻译成统一 AppError，并按 §6.2 分类判定
 * recoverable（转 tool_result 交 LLM 自纠）/ fatal（抛顶层中断 Loop）
 * 以及 retryable（Provider 层指数退避）。
 *
 * 二分契约（详设 §6.1）：
 *   recoverable:true  → 转 tool_result(is_error:true)，Loop 继续
 *   recoverable:false → 抛顶层，中断 Loop
 *
 * 分类依据详设 §6.2 表。禁止裸 throw 字符串（防御性兜底）。
 */

import type { AppError } from './types.js'

/** 把任意异常归一为 AppError。 */
export function toAppError(e: unknown): AppError {
  // 1) 已是 AppError：透传（避免重复包装）
  if (isAppError(e)) return e

  // 2) AbortError：用户中断（recoverable，Loop 的 try/catch 会设 stopReason='aborted'）
  if (isAbortError(e)) {
    return {
      code: 'ABORTED',
      message: '请求被中断',
      recoverable: true,
      context: { name: e.name },
    }
  }

  // 3) HTTP/SDK 错误（带 status 码）：按状态码分类
  const status = extractStatus(e)
  if (status !== undefined) {
    return fromHttpStatus(status, e)
  }

  // 4) JSON 解析失败：流式 tool_use JSON 拼接 parse 失败，recoverable 交 LLM 自纠
  if (e instanceof SyntaxError) {
    return {
      code: 'JSON_PARSE',
      message: `JSON 解析失败: ${e.message}`,
      recoverable: true,
    }
  }

  // 5) 普通 Error：默认 recoverable（能让 LLM 处理的尽量交 LLM）
  if (e instanceof Error) {
    return {
      code: 'INTERNAL',
      message: e.message,
      recoverable: true,
      context: { name: e.name, stack: e.stack },
    }
  }

  // 6) 字符串/其它：防御性兜底（规范禁止裸 throw 字符串，但仍兜底）
  return {
    code: 'UNKNOWN',
    message: String(e),
    recoverable: true,
  }
}

/** 把 stop_reason='error' 转成 fatal AppError（详设 §3.1 停止判定）。 */
export function toFatal(stopReason: 'error'): AppError {
  return {
    code: 'STREAM_ERROR',
    message: `流内错误 (stop_reason=${stopReason})`,
    recoverable: false,
  }
}

// —— 辅助 —— //

function isAppError(e: unknown): e is AppError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'recoverable' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    typeof (e as { recoverable: unknown }).recoverable === 'boolean'
  )
}

function isAbortError(e: unknown): e is Error {
  return e instanceof Error && (e.name === 'AbortError' || 'aborted' in e)
}

/** 从 SDK/HTTP 错误对象防御性提取状态码（@anthropic-ai/sdk 用 status）。 */
function extractStatus(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const obj = e as Record<string, unknown>
  const s = obj.status ?? obj.statusCode ?? obj.status_code
  return typeof s === 'number' ? s : undefined
}

/** HTTP 状态码 → AppError 分类（详设 §6.2）。 */
function fromHttpStatus(status: number, e: unknown): AppError {
  const msg = e instanceof Error ? e.message : `HTTP ${status}`

  if (status === 401 || status === 403) {
    return { code: 'AUTH_ERROR', message: `认证失败: ${msg}`, recoverable: false, context: { status } }
  }
  if (status === 404) {
    return { code: 'MODEL_NOT_FOUND', message: `模型/资源不存在: ${msg}`, recoverable: false, context: { status } }
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', message: `限流: ${msg}`, recoverable: true, retryable: true, context: { status } }
  }
  if (status === 408 || status === 599) {
    return { code: 'TIMEOUT', message: `请求超时: ${msg}`, recoverable: true, retryable: true, context: { status } }
  }
  if (status >= 500) {
    return { code: 'UPSTREAM_ERROR', message: `上游错误: ${msg}`, recoverable: true, retryable: true, context: { status } }
  }
  // 其它 4xx 等：默认 recoverable
  return { code: 'HTTP_ERROR', message: msg, recoverable: true, context: { status } }
}
