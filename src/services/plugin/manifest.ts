/**
 * plugin 清单解析（M7 P-P1，方案 P3.1/P3.3）。
 *
 * 清单只放元数据，组件靠目录约定自动发现（skills/、commands/、.mcp.json、hooks/hooks.json
 * 存在即扫）——零配置可发；显式声明字段可覆盖约定。未知字段剥离（作者加自定义字段不致失败）。
 * 双目录探测：`.ecode-plugin/plugin.json` 优先，`.claude-plugin/plugin.json` 回退
 * （贴 Claude 生态兼容——skills + mcpServers 两类资源可直接消费）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import AjvImport, { type ValidateFunction } from 'ajv'
import type { McpServerConfig } from '../mcp/config.js'
import { parseHookSpecs } from '../hooks/validate.js'
import type { HookSpec } from '../hooks/types.js'

/** ajv 8 NodeNext interop（同 tools/registry.ts）。 */
type AjvInstance = { compile: (schema: object) => ValidateFunction }
const Ajv =
  (AjvImport as unknown as { default?: new (o: object) => AjvInstance }).default ??
  (AjvImport as unknown as new (o: object) => AjvInstance)

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
/** 官方名预留（M7-D5：防官方伪装）。 */
export const RESERVED_PLUGIN_NAMES = new Set(['ecode', 'ecode-official', 'ecode-plugins-official'])

export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: { name: string }
  homepage?: string
  license?: string
  keywords?: string[]
  /** 组件显式声明（相对路径，必须在 plugin 根内）；缺省走目录约定 */
  skills?: string[]
  commands?: string[]
  mcpServers?: Record<string, McpServerConfig>
  hooks?: HookSpec[]
}

/** 组件发现结果（约定 + 声明合并后的绝对路径/配置）。 */
export interface PluginComponents {
  skillsDirs: string[]
  commandsDirs: string[]
  mcpServers: Record<string, McpServerConfig>
  hooks: HookSpec[]
  warnings: string[]
}

const manifestSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', pattern: PLUGIN_NAME_RE.source },
    version: { type: 'string' },
    description: { type: 'string' },
    author: { type: 'object', properties: { name: { type: 'string' } } },
    homepage: { type: 'string' },
    license: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'string' } },
    mcpServers: { type: 'object' },
    hooks: { type: 'array' },
  },
}

const validateManifest: ValidateFunction = new Ajv({ strict: false }).compile(manifestSchema)

/** 版本字符串净化（P3.3：路径穿越防护，[^a-zA-Z0-9\-_.] → -）。 */
export function sanitizeVersion(v: string): string {
  return v.replace(/[^a-zA-Z0-9\-_.]/g, '-').replace(/^\.+/, 'm') || '0.0.0'
}

/**
 * 相对路径净化：拒绝绝对路径 / `..` 上跳 / 盘符（P8 安全四件套）。
 * 返回 null = 非法（调用方 warn + 跳过）。
 */
export function sanitizeRelPath(rel: string): string | null {
  if (rel === '' || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return null
  if (/^[a-zA-Z]:/.test(rel)) return null
  const norm = path.normalize(rel).split(path.sep).join('/')
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) return null
  return norm
}

/** plugin 根目录下探测清单（.ecode-plugin 优先 .claude-plugin 回退）。返回清单绝对路径或 null。 */
export function findManifestFile(root: string): string | null {
  for (const dir of ['.ecode-plugin', '.claude-plugin']) {
    const f = path.join(root, dir, 'plugin.json')
    if (fs.existsSync(f)) return f
  }
  return null
}

/** 解析 plugin.json 文本（未知字段剥离；非法 → throw 带上下文）。 */
export function parsePluginManifest(text: string, origin: string): PluginManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`plugin.json 解析失败（${origin}）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof raw !== 'object' || raw === null) throw new Error(`plugin.json 不是对象（${origin}）`)
  if (!validateManifest(raw)) {
    const detail = (validateManifest.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ')
    throw new Error(`plugin.json 校验失败（${origin}）：${detail}`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.name === 'string' && RESERVED_PLUGIN_NAMES.has(r.name)) {
    throw new Error(`plugin 名「${r.name}」为官方保留名，禁止第三方使用（${origin}）`)
  }
  // 白名单剥离重建（未知字段丢弃）
  const m: PluginManifest = {
    name: r.name as string,
    version: sanitizeVersion(typeof r.version === 'string' ? r.version : '0.0.0'),
  }
  if (typeof r.description === 'string') m.description = r.description
  if (typeof r.author === 'object' && r.author !== null && typeof (r.author as { name?: unknown }).name === 'string') {
    m.author = { name: (r.author as { name: string }).name }
  }
  if (typeof r.homepage === 'string') m.homepage = r.homepage
  if (typeof r.license === 'string') m.license = r.license
  if (Array.isArray(r.keywords)) m.keywords = r.keywords.filter((k): k is string => typeof k === 'string')
  if (Array.isArray(r.skills)) m.skills = sanitizePathList(r.skills, 'skills', origin)
  if (Array.isArray(r.commands)) m.commands = sanitizePathList(r.commands, 'commands', origin)
  if (typeof r.mcpServers === 'object' && r.mcpServers !== null) m.mcpServers = r.mcpServers as Record<string, McpServerConfig>
  if (Array.isArray(r.hooks)) {
    const { hooks } = parseHookSpecs(r.hooks, `plugin.json hooks`)
    m.hooks = hooks
  }
  return m
}

/** 声明的路径列表净化（非法项丢弃，不整单失败）。 */
function sanitizePathList(list: unknown[], field: string, origin: string): string[] {
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const clean = sanitizeRelPath(item)
    if (clean === null) {
      throw new Error(`plugin.json ${field} 路径非法（疑似路径穿越）：${item}（${origin}）`)
    }
    out.push(clean)
  }
  return out
}

/**
 * 组件发现（约定 + 声明合并，P4.3 的扫描入口）。
 * - skills/commands：显式声明优先，否则目录约定（skills/、commands/ 存在即用）
 * - mcpServers：清单声明 + 根 .mcp.json 合并（声明优先）
 * - hooks：清单声明 + hooks/hooks.json 合并
 */
/** 组件目录解析：声明优先（非法警告），否则约定（不存在静默——"存在即扫"语义）。 */
function resolveComponentDirs(
  root: string,
  declared: string[] | undefined,
  convention: string,
  warnings: string[],
): string[] {
  const rels = declared ?? [convention]
  const out: string[] = []
  for (const rel of rels) {
    const abs = path.resolve(root, rel)
    try {
      if (fs.statSync(abs).isDirectory()) {
        out.push(abs)
        continue
      }
    } catch {
      // 不存在
    }
    if (declared !== undefined) warnings.push(`声明目录不存在，已跳过：${abs}`)
  }
  return out
}

export function discoverComponents(root: string, m: PluginManifest): PluginComponents {
  const warnings: string[] = []

  // 显式声明（不存在 → warn）；目录约定（不存在 → 静默跳过——零配置 skill-only plugin 是常态）
  const skillsDirs = resolveComponentDirs(root, m.skills, 'skills', warnings)
  const commandsDirs = resolveComponentDirs(root, m.commands, 'commands', warnings)

  const mcpServers: Record<string, McpServerConfig> = {}
  const mcpJsonPath = path.join(root, '.mcp.json')
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> }
      Object.assign(mcpServers, parsed.mcpServers ?? {})
    } catch (e) {
      warnings.push(`.mcp.json 解析失败，已忽略：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  Object.assign(mcpServers, m.mcpServers ?? {}) // 清单声明优先覆盖

  let hooks: HookSpec[] = [...(m.hooks ?? [])]
  const hooksJsonPath = path.join(root, 'hooks', 'hooks.json')
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const parsed = parseHookSpecs(JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')), 'hooks/hooks.json')
      hooks = [...hooks, ...parsed.hooks]
      warnings.push(...parsed.warnings)
    } catch (e) {
      warnings.push(`hooks/hooks.json 解析失败，已忽略：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { skillsDirs, commandsDirs, mcpServers, hooks, warnings }
}
