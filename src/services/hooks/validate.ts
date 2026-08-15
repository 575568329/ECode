/**
 * 用户源 hooks 解析（H1 源 1）：config.json `hooks` 键（原始 unknown）→ 过滤后的 HookSpec[]。
 *
 * AJV 校验（JSON Schema 原生）：非法项跳过 + warn，不炸启动（与 mcpServers 同容错策略）。
 * MVP 只接受 kind:'command'；mcp_tool/prompt 是接口位预留，出现在用户 config 里按
 * "未实现的形态"拒绝（等实现后放开 schema）。
 */

import AjvImport, { type ValidateFunction } from 'ajv'
import type { HookSpec } from './types.js'
import { HOOK_EVENTS } from './types.js'

/** ajv 8 在 NodeNext 下 default 可能被解析为 namespace（同 tools/registry.ts 的 interop 处理）。 */
type AjvInstance = { compile: (schema: object) => ValidateFunction }
const Ajv =
  (AjvImport as unknown as { default?: new (o: object) => AjvInstance }).default ??
  (AjvImport as unknown as new (o: object) => AjvInstance)

const ajv = new Ajv({ strict: false })

const hookSpecSchema = {
  type: 'object',
  required: ['event', 'handler'],
  properties: {
    event: { type: 'string', enum: [...HOOK_EVENTS] },
    matcher: { type: 'string' },
    handler: {
      type: 'object',
      required: ['kind', 'command'],
      properties: {
        kind: { const: 'command' },
        command: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'number' },
        async: { type: 'boolean' },
      },
    },
    timeout_ms: { type: 'number' },
  },
}

const validate: ValidateFunction = ajv.compile(hookSpecSchema)

export interface ParsedUserHooks {
  hooks: HookSpec[]
  warnings: string[]
}

/** 数组级解析（label 用于 warning 定位前缀）：config hooks 键与 skill/plugin 的 hooks.json 共用。 */
export function parseHookSpecs(raw: unknown, label = 'hooks'): ParsedUserHooks {
  if (raw === undefined || raw === null) return { hooks: [], warnings: [] }
  if (!Array.isArray(raw)) return { hooks: [], warnings: [`${label} 必须是数组，已忽略`] }
  if (raw.length === 0) return { hooks: [], warnings: [] }

  const hooks: HookSpec[] = []
  const warnings: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const idx = `${label}[${i}]`
    if (typeof item !== 'object' || item === null) {
      warnings.push(`${idx} 不是对象，已跳过`)
      continue
    }
    if (!validate(item)) {
      const detail = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ')
      // mcp_tool/prompt 后置形态的友好提示（schema 只认 command，这里补人话）
      const kind = (item as { handler?: { kind?: string } }).handler?.kind
      const kindHint =
        kind !== undefined && kind !== 'command' ? `（形态 ${kind} 未实现，MVP 仅支持 command）` : ''
      warnings.push(`${idx} 校验失败已跳过：${detail}${kindHint}`)
      continue
    }
    hooks.push(item as unknown as HookSpec)
  }
  return { hooks, warnings }
}

/** 用户源（config.json 的 hooks 键）。 */
export function parseUserHooks(raw: unknown): ParsedUserHooks {
  return parseHookSpecs(raw, 'hooks')
}
