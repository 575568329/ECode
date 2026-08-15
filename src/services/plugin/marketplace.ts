/**
 * marketplace.json 解析（M7 P-P1，方案 P3.2）。
 *
 * 市场索引仓库的清单：name + plugins[]（每项含 source）。MVP source 三类：
 * github（owner/repo + ref + sha，git shallow clone）、url（zip + sha256）、
 * local（市场内相对路径）。
 */

import AjvImport, { type ValidateFunction } from 'ajv'

/** ajv 8 NodeNext interop（同 tools/registry.ts）。 */
type AjvInstance = { compile: (schema: object) => ValidateFunction }
const Ajv =
  (AjvImport as unknown as { default?: new (o: object) => AjvInstance }).default ??
  (AjvImport as unknown as new (o: object) => AjvInstance)

export type PluginSource =
  | { source: 'github'; repo: string; ref?: string; sha?: string }
  | { source: 'url'; url: string; sha256?: string }
  | { source: 'local'; path: string }

export interface MarketplacePluginEntry {
  name: string
  description?: string
  version?: string
  source: PluginSource
}

export interface MarketplaceManifest {
  name: string
  owner?: { name: string }
  plugins: MarketplacePluginEntry[]
}

const entrySchema = {
  type: 'object',
  required: ['name', 'source'],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    version: { type: 'string' },
    source: {
      oneOf: [
        {
          type: 'object',
          required: ['source', 'repo'],
          properties: {
            source: { const: 'github' },
            repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
            ref: { type: 'string' },
            sha: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['source', 'url'],
          properties: {
            source: { const: 'url' },
            url: { type: 'string', pattern: '^https?://' },
            sha256: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['source', 'path'],
          properties: {
            source: { const: 'local' },
            path: { type: 'string', pattern: '^\\./' },
          },
        },
      ],
    },
  },
}

const marketplaceSchema = {
  type: 'object',
  required: ['name', 'plugins'],
  properties: {
    name: { type: 'string', minLength: 1 },
    owner: { type: 'object', properties: { name: { type: 'string' } } },
    plugins: { type: 'array', items: entrySchema },
  },
}

const validateMarketplace: ValidateFunction = new Ajv({ strict: false }).compile(marketplaceSchema)

/** 解析 marketplace.json 文本；非法 → throw 带上下文。 */
export function parseMarketplaceManifest(text: string, origin: string): MarketplaceManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`marketplace.json 解析失败（${origin}）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!validateMarketplace(raw)) {
    const detail = (validateMarketplace.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ')
    throw new Error(`marketplace.json 校验失败（${origin}）：${detail}`)
  }
  const r = raw as Record<string, unknown>
  const out: MarketplaceManifest = { name: r.name as string, plugins: [] }
  if (typeof r.owner === 'object' && r.owner !== null && typeof (r.owner as { name?: unknown }).name === 'string') {
    out.owner = { name: (r.owner as { name: string }).name }
  }
  for (const p of r.plugins as Array<Record<string, unknown>>) {
    const src = p.source as Record<string, unknown>
    const entry: MarketplacePluginEntry = { name: p.name as string, source: src as unknown as PluginSource }
    if (typeof p.description === 'string') entry.description = p.description
    if (typeof p.version === 'string') entry.version = p.version
    out.plugins.push(entry)
  }
  return out
}

/** marketplace.json 的标准位置（市场仓库根下）。 */
export const MARKETPLACE_MANIFEST_REL = '.ecode-plugin/marketplace.json'
