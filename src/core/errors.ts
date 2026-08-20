/**
 * 错误归一化：把任意异常翻译成统一 AppError，并按 §6.2 分类判定
 * recoverable（转 tool_result 交 LLM 自纠）/ fatal（抛顶层中断 Loop）
 * 以及 retryable（loop 侧指数退避重试；客户端错 400/401/403/404/422 为 false——
 * 同请求重试必同错，退避是纯空转）。
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

  // 5) 普通 Error：默认 recoverable（能让 LLM 处理的尽量交 LLM）。
  //    网络类（连接失败/超时，无 HTTP status）显式 retryable:true——退避后大概率自愈
  if (e instanceof Error) {
    return {
      code: 'INTERNAL',
      message: e.message,
      recoverable: true,
      ...(isNetworkError(e) ? { retryable: true } : {}),
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

/** 网络类错误特征（无 status 的连接层失败）：Node errno / fetch 话术 / SDK 连接错。
 *  Why：这类错退避后大概率自愈（retryable:true）；其余普通 Error 不显式标记，
 *  由 loop 按 retryable !== false 默认放行重试。 */
const NETWORK_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|network error|socket hang up|connection (error|reset|refused|closed)/i

function isNetworkError(e: Error): boolean {
  if (NETWORK_ERROR_RE.test(e.message) || NETWORK_ERROR_RE.test(e.name)) return true
  // fetch 失败常把真因放 cause（TypeError: fetch failed → cause: Error connect ECONNREFUSED）
  const cause = (e as { cause?: unknown }).cause
  return cause instanceof Error && NETWORK_ERROR_RE.test(cause.message)
}

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

/** HTTP 状态码 → AppError 分类（详设 §6.2）。message 用提炼后的人话一行（briefHttpMessage）；
 *  原始全文（含 JSON body）进 context.raw——日志/排障可查，UI 不被几百字符撑碎。 */
function fromHttpStatus(status: number, e: unknown): AppError {
  const raw = e instanceof Error ? e.message : `HTTP ${status}`
  const brief = briefHttpMessage(e, raw)

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_ERROR',
      message: `认证失败（${status}）：${brief}`,
      recoverable: false,
      retryable: false,
      context: { status, raw },
    }
  }
  if (status === 404) {
    return {
      code: 'MODEL_NOT_FOUND',
      message: `模型/资源不存在（404）：${brief}`,
      recoverable: false,
      retryable: false,
      context: { status, raw },
    }
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', message: `限流（429）：${brief}`, recoverable: true, retryable: true, context: { status, raw } }
  }
  if (status === 408 || status === 599) {
    return { code: 'TIMEOUT', message: `请求超时（${status}）：${brief}`, recoverable: true, retryable: true, context: { status, raw } }
  }
  if (status >= 500) {
    return { code: 'UPSTREAM_ERROR', message: `上游错误（${status}）：${brief}`, recoverable: true, retryable: true, context: { status, raw } }
  }
  // 400：区分上下文超限（压缩兜底，recoverable:false 跳过退避走 M5 §6.3）vs 其它参数错误（交 LLM 自纠）。
  // 400/422 客户端错：同请求重试必同错（纯空转）——retryable:false，loop 不退避直接终止
  if (status === 400 || status === 422) {
    const bodyMsg = extractErrorMessage(e)
    if (status === 400 && bodyMsg && CONTEXT_TOO_LONG_RE.test(bodyMsg)) {
      return { code: 'CONTEXT_TOO_LONG', message: `上下文超限: ${bodyMsg}`, recoverable: false, context: { status, raw } }
    }
    return { code: 'HTTP_ERROR', message: brief, recoverable: true, retryable: false, context: { status, raw } }
  }
  // 其它 4xx 等：默认 recoverable
  return { code: 'HTTP_ERROR', message: brief, recoverable: true, context: { status, raw } }
}

/** 上下文超限正则：各家端点表述不一，宽匹配但要求 context/token/length 语义（避免「某字段 too long」误判）。 */
const CONTEXT_TOO_LONG_RE = /context.*(length|window|token|exceed)|maximum.*context|prompt.*too.*long|(exceed|maximum).*token/i

/** 从 SDK 错误对象防御性提取 body message（各家嵌套结构不同）。
 * 优先级：e.error.error.message（Anthropic 二层）> e.error.message（OpenAI 一层）> e.message（裸）。 */
function extractErrorMessage(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const obj = e as Record<string, unknown>
  const err1 = obj.error
  if (err1 !== null && typeof err1 === 'object') {
    const err2 = (err1 as Record<string, unknown>).error
    if (err2 !== null && typeof err2 === 'object') {
      const m2 = (err2 as Record<string, unknown>).message
      if (typeof m2 === 'string') return m2
    }
    const m1 = (err1 as Record<string, unknown>).message
    if (typeof m1 === 'string') return m1
  }
  if (e instanceof Error) return e.message
  return undefined
}

/** 嵌套提取 body 的错误码（error.error.code > error.code；如智谱 1308）。 */
function extractErrorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const obj = e as Record<string, unknown>
  const err1 = obj.error
  if (err1 !== null && typeof err1 === 'object') {
    const err2 = (err1 as Record<string, unknown>).error
    if (err2 !== null && typeof err2 === 'object') {
      const c2 = (err2 as Record<string, unknown>).code
      if (typeof c2 === 'string' && c2 !== '') return c2
    }
    const c1 = (err1 as Record<string, unknown>).code
    if (typeof c1 === 'string' && c1 !== '') return c1
  }
  return undefined
}

/** 提炼文案长度上限（人话一行够用；原始全文在 context.raw）。 */
const BRIEF_MSG_MAX = 160

/** 首行 + 截断（SDK message 可能多行/超长）。 */
function firstLineClamp(s: string): string {
  const line = (s.split(/\r?\n/)[0] ?? s).trim()
  return line.length > BRIEF_MSG_MAX ? `${line.slice(0, BRIEF_MSG_MAX - 1)}…` : line
}

/**
 * SDK 错误 → 人话一行：SDK 的 message 常拼完整 JSON body（如 `429 {"error":{...}}`），
 * 直接透传 UI 会被几百字符撑碎。提炼优先级：
 * ① 错误对象嵌套 error.message（extractErrorMessage，Anthropic/OpenAI 结构化）带 code；
 * ② message 里的 JSON 块解析（部分端点只给拼接字符串）；
 * ③ 回退原文首行截断。
 */
function briefHttpMessage(e: unknown, raw: string): string {
  const bodyMsg = extractErrorMessage(e)
  if (bodyMsg !== undefined && bodyMsg !== raw) {
    const code = extractErrorCode(e)
    return firstLineClamp(code !== undefined ? `[${code}] ${bodyMsg}` : bodyMsg)
  }
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as Record<string, unknown>
      const err =
        typeof parsed.error === 'object' && parsed.error !== null
          ? (parsed.error as Record<string, unknown>)
          : parsed
      const code = err.code
      const msg = err.message
      if (typeof msg === 'string' && msg !== '') {
        return firstLineClamp(typeof code === 'string' && code !== '' ? `[${code}] ${msg}` : msg)
      }
    } catch {
      // 非 JSON（`{` 只是普通字符）——走回退
    }
  }
  return firstLineClamp(raw)
}
