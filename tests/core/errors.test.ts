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

describe('toFatal', () => {
  it("stop_reason='error' → fatal STREAM_ERROR", () => {
    const err = toFatal('error')
    expect(err.recoverable).toBe(false)
    expect(err.code).toMatch(/ERROR/i)
  })
})
