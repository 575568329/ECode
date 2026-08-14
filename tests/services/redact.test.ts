import { describe, it, expect } from 'vitest'
import { redact } from '../../src/services/redact.js'

describe('redact', () => {
  it('字符串 sk- 密钥', () => {
    expect(redact('key=sk-abc123def456ghi789jkl012mno345')).toBe('key=[REDACTED]')
  })

  it('字符串 64 位 hex', () => {
    expect(redact('a'.repeat(64))).toBe('[REDACTED]')
  })

  it('GLM key（{id}.{secret}）', () => {
    expect(redact('key=abcdef12.abcdefghijklmnopqrstuvwx')).toBe('key=[REDACTED]')
  })

  it('env 赋值 API_KEY=...', () => {
    expect(redact('MY_API_KEY=sk-secret123')).toBe('MY_API_KEY=[REDACTED]')
    expect(redact('export OPENAI_TOKEN=abc.def.ghi')).toBe('export OPENAI_TOKEN=[REDACTED]')
  })

  it('对象 apiKey 字段', () => {
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

  it('原始值原样', () => {
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
    expect(redact(true)).toBe(true)
    expect(redact(undefined)).toBe(undefined)
  })

  it('环引用不栈溢出（返回 [CIRCULAR]）', () => {
    const a: Record<string, unknown> = { x: 1 }
    a.self = a
    const r = redact(a) as Record<string, unknown>
    expect(r.x).toBe(1)
    expect(r.self).toBe('[CIRCULAR]')
  })

  it('超深嵌套返回 [MAX_DEPTH]', () => {
    let v: unknown = 'deep'
    for (let i = 0; i < 15; i++) v = { nested: v }
    const r = redact(v) as Record<string, unknown>
    // 10 层后变 [MAX_DEPTH]
    expect(JSON.stringify(r)).toContain('[MAX_DEPTH]')
  })
})

describe('redact MCP（M6 M-P9）', () => {
  it('mcpServers 配置的 headers 整块脱敏；env 里密钥模式脱敏', () => {
    const cfg = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          headers: { Authorization: 'Bearer ghp_xxx', 'X-Api-Key': 'k' },
          env: { GITHUB_TOKEN: 'ghp_abcdefabcdefabcdef' },
        },
      },
    }
    const out = redact(cfg) as typeof cfg
    expect(JSON.stringify(out)).not.toContain('ghp_')
    expect((out.mcpServers.github as Record<string, unknown>)['headers']).toBe('[REDACTED]')
  })
})
