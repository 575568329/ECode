/**
 * MCP 配置（M6 M3.1 / M-P5）：类型 + 两层合并 + ${ENV_VAR} 展开 + 项目级首用批准。
 *
 * 来源（优先级：用户级 < 项目级同名覆盖 + warn；plugin 级随 M7）：
 *   - 用户级 ~/.ecode/config.json 的 mcpServers
 *   - 项目级 <cwd>/.mcp.json（团队共享；secret 用 ${ENV_VAR} 占位符；首用批准 hash 持久化）
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export interface McpServerConfig {
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** 默认 true；false → disabled（不注册工具） */
  enabled?: boolean
  /** 默认 lazy；eager/keep-alive 启动即连；lazy-keep-alive 首用后常驻（M6-D15） */
  lifecycle?: 'lazy' | 'eager' | 'keep-alive' | 'lazy-keep-alive'
  /** 空闲断开分钟数（lazy 默认 10；eager/keep-alive 系默认 0=不断开） */
  idleTimeout?: number
  /** 单次调用/连接超时 ms，默认 30000 */
  timeout?: number
}

export interface McpServerEntry {
  name: string
  /** ENV_VAR 展开后的配置（连接用） */
  cfg: McpServerConfig
  /** 展开前的原始配置（configHash 用——展开后 headers 可能含 secret，哈希落盘=留离线校验器，审阅 P2） */
  rawCfg?: McpServerConfig
  source: 'user' | 'project' | 'plugin'
}

/** 项目级 .mcp.json 原始格式（业界 de-facto：{ "mcpServers": { name: cfg } }）。 */
interface ProjectMcpFile {
  mcpServers?: Record<string, McpServerConfig>
}

/** 展开配置里的 ${ENV_VAR} 占位符（缺失 → 返回缺失变量名列表；AGENTS §5.2 secret 从环境读）。
 *  F-18 尾巴（批2c）：F-18 根修后 .env 值不再提升进 process.env，${ENV_VAR} 只读 process.env
 *  会与 .env 静默解耦（server 因 missing 被静默跳过）。fallback 注入 loadConfig 的 dotenvMap，
 *  优先级 process.env > .env（外部注入压过文件，与 config.ts 主链同语义）。 */
export function expandEnvVars(cfg: McpServerConfig, fallback: Record<string, string> = {}): { cfg: McpServerConfig; missing: string[] } {
  const missing: string[] = []
  const expandStr = (s: string): string =>
    s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, v: string) => {
      const val = process.env[v] ?? fallback[v]
      if (val === undefined) {
        missing.push(v)
        return ''
      }
      return val
    })
  const expandMap = (m?: Record<string, string>): Record<string, string> | undefined =>
    m === undefined ? undefined : Object.fromEntries(Object.entries(m).map(([k, v]) => [k, expandStr(v)]))
  return {
    cfg: {
      ...cfg,
      command: cfg.command !== undefined ? expandStr(cfg.command) : undefined,
      args: cfg.args?.map(expandStr),
      url: cfg.url !== undefined ? expandStr(cfg.url) : undefined,
      env: expandMap(cfg.env),
      headers: expandMap(cfg.headers),
    },
    missing,
  }
}

/** 校验单条 server 配置（type 与必填字段对齐；非法返回错误信息）。 */
export function validateServerConfig(name: string, cfg: McpServerConfig): string | undefined {
  if (cfg.type !== 'stdio' && cfg.type !== 'http') return `mcpServers.${name}.type 须为 stdio|http`
  if (cfg.type === 'stdio' && (cfg.command === undefined || cfg.command === '')) {
    return `mcpServers.${name}（stdio）缺 command`
  }
  if (cfg.type === 'http' && (cfg.url === undefined || cfg.url === '')) {
    return `mcpServers.${name}（http）缺 url`
  }
  return undefined
}

/**
 * 读项目级 .mcp.json（审阅修复边界）：
 * - home 前停（~/.mcp.json 不是任何项目的项目级配置）
 * - cwd 不在 home 子树（Windows 跨盘）：上界收在最近 git 根（含）——防盘根 .mcp.json 批准一次全盘生效
 *   （盘根文件能 spawn 子进程，波及面不可接受）；非 git 目录只查 start 本身
 */
export function findProjectMcpJson(start: string): string | null {
  const found = findUpFile(start, '.mcp.json')
  return found ?? null
}

/** 有界向上找文件（边界策略与 skill.ts findUpDir 一致，避免两套漂移）。 */
function findUpFile(start: string, fileName: string): string | undefined {
  const home = os.homedir()
  const inHomeTree = (() => {
    const norm = (p: string): string => path.resolve(p).toLowerCase() + path.sep
    return norm(start).startsWith(norm(home))
  })()
  let dir = path.resolve(start)
  for (;;) {
    // home 边界先于命中检查（~/.mcp.json 不是任何项目的项目级配置）
    if (dir === home || path.dirname(dir) === dir) return undefined
    const candidate = path.join(dir, fileName)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (!inHomeTree) {
      if (parent !== home && !fs.existsSync(path.join(parent, '.git'))) return undefined
    }
    dir = parent
  }
}

/** 读 + 解析项目级 .mcp.json（读失败/格式错 → null + warn 由调用方记）。 */
export function loadProjectMcpJson(file: string): Record<string, McpServerConfig> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectMcpFile
    if (parsed.mcpServers === null || typeof parsed.mcpServers !== 'object') return {}
    return parsed.mcpServers
  } catch {
    return null
  }
}

// —— 首用批准（v3 P1-4 / v6 二段启动）：hash 持久化，批准后不再问 —— //

const DEFAULT_APPROVED_FILE = path.join(os.homedir(), '.ecode', 'approved-mcp.json')
/** 批准注册表路径（测试注入隔离 home，生产用默认）。 */
let approvedFile: string = DEFAULT_APPROVED_FILE

export function setApprovedFilePath(file: string): void {
  approvedFile = file
}

export function mcpFileHash(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

export function isMcpApproved(file: string): boolean {
  try {
    const approved = JSON.parse(fs.readFileSync(approvedFile, 'utf8')) as { files?: string[] }
    return (approved.files ?? []).includes(mcpFileHash(file))
  } catch {
    return false
  }
}

export function approveMcpFile(file: string): void {
  let approved: { files?: string[] } = {}
  try {
    approved = JSON.parse(fs.readFileSync(approvedFile, 'utf8')) as { files?: string[] }
  } catch {
    approved = {}
  }
  const files = new Set(approved.files ?? [])
  files.add(mcpFileHash(file))
  fs.mkdirSync(path.dirname(approvedFile), { recursive: true })
  fs.writeFileSync(approvedFile, JSON.stringify({ files: [...files] }, null, 2), 'utf8')
}

/**
 * 合并用户级 + 项目级（项目级同名覆盖）。返回条目列表 + 警告。
 * @param userServers 用户级 config.json 的 mcpServers（可为 undefined）
 * @param projectFile 项目级 .mcp.json 路径（null = 无）；未经批准时调用方应先不传（二段启动）
 */
export function mergeMcpServers(
  userServers: Record<string, McpServerConfig> | undefined,
  projectServers: Record<string, McpServerConfig> | undefined,
  envFallback: Record<string, string> = {},
): { entries: McpServerEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const merged = new Map<string, McpServerEntry>()
  for (const [name, cfg] of Object.entries(userServers ?? {})) {
    merged.set(name, { name, cfg, source: 'user' })
  }
  for (const [name, cfg] of Object.entries(projectServers ?? {})) {
    if (merged.has(name)) warnings.push(`MCP server「${name}」项目级覆盖用户级`)
    merged.set(name, { name, cfg, source: 'project' })
  }
  const entries: McpServerEntry[] = []
  for (const [name, e] of merged) {
    const invalid = validateServerConfig(name, e.cfg)
    if (invalid !== undefined) {
      warnings.push(invalid + '，已跳过')
      continue
    }
    const { cfg, missing } = expandEnvVars(e.cfg, envFallback)
    if (missing.length > 0) {
      warnings.push(`MCP server「${name}」环境变量缺失：${missing.join(', ')}，已跳过`)
      continue
    }
    entries.push({ name, cfg, ...(e.cfg !== cfg ? { rawCfg: e.cfg } : {}), source: e.source })
  }
  return { entries, warnings }
}
