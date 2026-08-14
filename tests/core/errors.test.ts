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

describe('toFatal', () => {
  it("stop_reason='error' → fatal STREAM_ERROR", () => {
    const err = toFatal('error')
    expect(err.recoverable).toBe(false)
    expect(err.code).toMatch(/ERROR/i)
  })
})
