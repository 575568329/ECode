import { describe, it, expect } from 'vitest'
import { toAppError, toFatal } from '../../src/core/errors.js'
import type { AppError } from '../../src/core/types.js'

describe('toAppError', () => {
  it('已是 AppError 时透传', () => {
    const err: AppError = { code: 'CUSTOM', message: 'x', recoverable: false }
    expect(toAppError(err)).toBe(err)
  })

  it('401 → fatal（无 Key/Token 过期）', () => {
    const e = Object.assign(new Error('unauthorized'), { status: 401 })
    const err = toAppError(e)
    expect(err.recoverable).toBe(false)
    expect(err.retryable).toBeFalsy()
    expect(err.code).toMatch(/AUTH|API_KEY|UNAUTHORIZED/i)
  })

  it('404 → fatal（模型不存在）', () => {
    const e = Object.assign(new Error('not found'), { status: 404 })
    const err = toAppError(e)
    expect(err.recoverable).toBe(false)
    expect(err.code).toMatch(/MODEL|NOT_FOUND/i)
  })

  it('429 → recoverable + retryable（限流，指数退避）', () => {
    const e = Object.assign(new Error('rate limit'), { status: 429 })
    const err = toAppError(e)
    expect(err.recoverable).toBe(true)
    expect(err.retryable).toBe(true)
    expect(err.code).toMatch(/RATE/i)
  })

  it('5xx → recoverable + retryable（上游错误）', () => {
    const e = Object.assign(new Error('server error'), { status: 500 })
    const err = toAppError(e)
    expect(err.recoverable).toBe(true)
    expect(err.retryable).toBe(true)
  })

  it('SyntaxError → recoverable（流式 JSON 解析失败，交 LLM 自纠）', () => {
    const err = toAppError(new SyntaxError('Unexpected token'))
    expect(err.recoverable).toBe(true)
    expect(err.code).toMatch(/JSON|PARSE/i)
  })

  it('普通 Error → recoverable（默认交 LLM 自纠）', () => {
    const err = toAppError(new Error('boom'))
    expect(err.recoverable).toBe(true)
    expect(err.message).toBe('boom')
  })

  it('AbortError → recoverable ABORTED（用户中断）', () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    const err = toAppError(e)
    expect(err.recoverable).toBe(true)
    expect(err.code).toMatch(/ABORT/i)
  })

  it('字符串 → recoverable（防御，禁止裸 throw 字符串）', () => {
    const err = toAppError('oops')
    expect(err.recoverable).toBe(true)
    expect(err.message).toBe('oops')
  })
})

describe('CONTEXT_TOO_LONG（400 上下文超限分类，M5 §6.5）', () => {
  it('Anthropic 400 body（error.error.message 二层嵌套）→ CONTEXT_TOO_LONG + recoverable:false', () => {
    const e = Object.assign(new Error('Request failed'), {
      status: 400,
      error: { type: 'invalid_request_error', error: { type: 'invalid_request_error', message: 'context length exceeded 200000 tokens' } },
    })
    const err = toAppError(e)
    expect(err.code).toBe('CONTEXT_TOO_LONG')
    expect(err.recoverable).toBe(false)
  })

  it('OpenAI 400 body（error.message 一层）→ CONTEXT_TOO_LONG', () => {
    const e = Object.assign(new Error('Request failed'), {
      status: 400,
      error: { message: "This model's maximum context window is 128000 tokens" },
    })
    const err = toAppError(e)
    expect(err.code).toBe('CONTEXT_TOO_LONG')
    expect(err.recoverable).toBe(false)
  })

  it('裸 message 400（prompt is too long）→ CONTEXT_TOO_LONG', () => {
    const e = Object.assign(new Error('prompt is too long: 250000 tokens > 200000 maximum'), { status: 400 })
    const err = toAppError(e)
    expect(err.code).toBe('CONTEXT_TOO_LONG')
    expect(err.recoverable).toBe(false)
  })

  it('maximum...token 表述 → CONTEXT_TOO_LONG', () => {
    const e = Object.assign(new Error('Request failed'), {
      status: 400,
      error: { message: 'You exceeded the maximum number of tokens allowed' },
    })
    const err = toAppError(e)
    expect(err.code).toBe('CONTEXT_TOO_LONG')
  })

  it('非 context 的 400（参数错误）→ HTTP_ERROR，不误判', () => {
    const e = Object.assign(new Error('Request failed'), {
      status: 400,
      error: { message: 'temperature must be between 0 and 2' },
    })
    const err = toAppError(e)
    expect(err.code).not.toBe('CONTEXT_TOO_LONG')
    expect(err.code).toBe('HTTP_ERROR')
    expect(err.recoverable).toBe(true)
  })
})

describe('HTTP 错误提炼（message 一行人话 + 原文进 context.raw）', () => {
  it('429 结构化（Anthropic 二层 error.error）→ message 提炼 body 文案带 code，raw 保全文', () => {
    const bodyMsg = '[1308][已达到 5 小时的使用上限。您的限额将在 2026-08-15 21:43:57 重置。][2026081520162210e13bcba22342b3]'
    const rawMsg = `429 {"type":"error","error":{"type":"rate_limit_error","code":"1308","message":${JSON.stringify(bodyMsg)},"request_id":"req_01"}}`
    const e = Object.assign(new Error(rawMsg), {
      status: 429,
      error: { type: 'error', error: { type: 'rate_limit_error', code: '1308', message: bodyMsg } },
    })
    const err = toAppError(e)
    expect(err.message).toBe(`限流（429）：[1308] ${bodyMsg}`)
    expect(err.message).not.toContain('{"type"') // 不含 JSON body
    expect((err.context as { raw?: string }).raw).toBe(rawMsg) // 原文完整保留（日志可查）
  })

  it('429 仅拼接字符串（无结构化 error 字段）→ 解析 message 里的 JSON 块提炼', () => {
    const rawMsg = '429 {"type":"error","error":{"type":"rate_limit_error","code":"1308","message":"quota exceeded until tomorrow"}}'
    const e = Object.assign(new Error(rawMsg), { status: 429 })
    const err = toAppError(e)
    expect(err.message).toBe('限流（429）：[1308] quota exceeded until tomorrow')
  })

  it('非 JSON 消息 → 原文首行截断（超 160 加省略号）', () => {
    const long = 'x'.repeat(300)
    const e = Object.assign(new Error(long), { status: 500 })
    const err = toAppError(e)
    expect(err.message.startsWith('上游错误（500）：x')).toBe(true)
    expect(err.message.length).toBeLessThanOrEqual('上游错误（500）：'.length + 160)
    expect(err.message.endsWith('…')).toBe(true)
  })

  it('多行消息 → 只取首行', () => {
    const e = Object.assign(new Error('first line' + String.fromCharCode(10) + 'second line'), { status: 401 })
    const err = toAppError(e)
    expect(err.message).toBe('认证失败（401）：first line')
  })

  it('短消息不受影响', () => {
    const e = Object.assign(new Error('rate limit'), { status: 429 })
    const err = toAppError(e)
    expect(err.message).toBe('限流（429）：rate limit')
  })
})

describe('toFatal', () => {
  it("stop_reason='error' → fatal STREAM_ERROR", () => {
    const err = toFatal('error')
    expect(err.recoverable).toBe(false)
    expect(err.code).toMatch(/ERROR/i)
  })
})
