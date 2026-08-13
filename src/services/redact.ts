/**
 * 脱敏（AGENTS §2.7/§5.2 + 详设 §4.4.5）：密钥模式 + 整字段，Logger/HistoryStore 共用。
 *
 * 模式清单：
 *   - sk-xxx（Anthropic）/ AKIA（AWS）/ 64 位 hex（GLM/DeepSeek 等通用）
 *   - GLM key 格式 {id}.{secret}
 *   - env 赋值：XXX_API_KEY=... / XXX_TOKEN=... / XXX_SECRET=...（保留 key 名，值替换）
 * 字段：apiKey/token/authorization/bearer/secret/password（子串匹配，覆盖 camelCase 变体）
 *
 * 注意：64-hex 会误杀合法 SHA-256（安全偏向，可接受）；递归有环引用保护 + 深度上限。
 */

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
  return s
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]')
    .replace(/[a-f0-9]{64}/gi, '[REDACTED]')
    .replace(/[a-f0-9]{8,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED]') // GLM {id}.{secret}
    .replace(/(\b[A-Z_]*API_KEY\b\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Z_]*TOKEN\b\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Z_]*SECRET\b\s*=\s*)\S+/gi, '$1[REDACTED]')
}

const MAX_DEPTH = 10

/** 递归脱敏：字符串扫密钥模式；对象敏感字段整体替换；带环引用保护 + 深度上限。 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1))
  if (value !== null && typeof value === 'object') {
    if (seen.has(value as object)) return '[CIRCULAR]'
    seen.add(value as object)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase()
      if (SENSITIVE_FIELDS.some((f) => lower.includes(f))) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = redact(v, seen, depth + 1)
      }
    }
    return out
  }
  return value
}
