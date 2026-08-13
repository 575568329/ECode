import { describe, it, expect } from 'vitest'
import { redact } from '../../src/services/redact.js'

describe('redact', () => {
  it('字符串 sk- 密钥 → [REDACTED]', () => {
    expect(redact('key=sk-abc123def456ghi789jkl012mno345')).toBe('key=[REDACTED]')
  })

  it('字符串 64 位 hex → [REDACTED]', () => {
    expect(redact('a'.repeat(64))).toBe('[REDACTED]')
  })

  it('对象 apiKey 字段整字段替换', () => {
    expect(redact({ apiKey: 'sk-secret', model: 'glm' })).toEqual({
      apiKey: '[REDACTED]',
      model: 'glm',
    })
  })

  it('嵌套对象递归', () => {
    expect(redact({ cfg: { apiKey: 'x' }, ok: true })).toEqual({
      cfg: { apiKey: '[REDACTED]' },
      ok: true,
    })
  })

  it('数组递归', () => {
    expect(redact(['sk-abc123def456ghi789jkl012mno345pqr', 'ok'])).toEqual(['[REDACTED]', 'ok'])
  })

  it('authorization / token / bearer 字段', () => {
    expect(redact({ Authorization: 'Bearer xxx', token: 't', xBearer: 'b' })).toEqual({
      Authorization: '[REDACTED]',
      token: '[REDACTED]',
      xBearer: '[REDACTED]',
    })
  })

  it('正常字段不脱敏', () => {
    expect(redact({ model: 'glm-5.2', path: '/x.ts', command: 'npm test' })).toEqual({
      model: 'glm-5.2',
      path: '/x.ts',
      command: 'npm test',
    })
  })

  it('原始值（数字/布尔/null/undefined）原样', () => {
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
    expect(redact(true)).toBe(true)
    expect(redact(undefined)).toBe(undefined)
  })
})
