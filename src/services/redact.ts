/**
 * 脱敏（AGENTS §2.7/§5.2）：密钥模式 + 整字段，Logger / HistoryStore 共用同一规则。
 * 防止 apiKey / token 落 trace 日志或对话历史。
 */

const KEY_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g, // Anthropic sk-...
  /AKIA[A-Z0-9]{16}/g, // AWS access key
  /[a-f0-9]{64}/gi, // 通用 64 位 hex（GLM/DeepSeek 等）
]

const SENSITIVE_FIELDS = [
  'apikey',
  'api_key',
  'authorization',
  'token',
  'secret',
  'password',
  'bearer',
]

function redactString(s: string): string {
  let r = s
  for (const p of KEY_PATTERNS) r = r.replace(p, '[REDACTED]')
  return r
}

/** 递归脱敏：字符串扫密钥模式；对象敏感字段整体替换；其余递归。 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase()
      if (SENSITIVE_FIELDS.some((f) => lower.includes(f))) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = redact(v)
      }
    }
    return out
  }
  return value
}
