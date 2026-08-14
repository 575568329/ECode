/**
 * MCP metadata cache（M6 M3.5 / M-P4）：tools/list 结果跨会话复用。
 *
 * lazy 默认的前提——「注册工具」与「连接 server」解耦：cache 命中时启动零连接
 * 也能注册全部工具；configHash（server 定义指纹）变更则条目作废。
 * 单文件 ~/.ecode/mcp-cache.json；读-改-写走串行队列（并发回写互相覆盖会丢条目，v6 审阅）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { McpServerConfig } from './config.js'

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: object
}

export interface McpCacheEntry {
  configHash: string
  tools: McpToolDef[]
  cachedAt: number
}

interface CacheFile {
  version: 1
  servers: Record<string, McpCacheEntry>
}

/** server 定义的指纹（command/args/url/headers 等变更 → 缓存作废）。 */
export function configHashOf(cfg: McpServerConfig): string {
  const json = JSON.stringify({
    type: cfg.type,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
    url: cfg.url,
    headers: cfg.headers,
  })
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16)
}

export class McpCache {
  private readonly file: string
  private data: CacheFile = { version: 1, servers: {} }
  /** 串行写队列（读-改-写互斥；队列尾链式追加）。 */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath?: string) {
    this.file = filePath ?? path.join(os.homedir(), '.ecode', 'mcp-cache.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CacheFile>
      if (parsed.version === 1 && parsed.servers !== null && typeof parsed.servers === 'object') {
        this.data = { version: 1, servers: parsed.servers }
      }
    } catch {
      this.data = { version: 1, servers: {} } // 缺失/损坏 → 空缓存（可重建）
    }
  }

  /** 命中条目（configHash 不匹配 = 未命中）。 */
  get(serverName: string, configHash: string): McpCacheEntry | undefined {
    const e = this.data.servers[serverName]
    if (e === undefined || e.configHash !== configHash) return undefined
    return e
  }

  /** 回写（串行队列防并发覆盖；失败静默——缓存丢失只影响下次启动需 bootstrap 连一次）。 */
  set(serverName: string, entry: McpCacheEntry): Promise<void> {
    this.data.servers[serverName] = entry
    this.writeQueue = this.writeQueue
      .then(() => {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
      })
      .catch(() => {})
    return this.writeQueue
  }

  /** 测试/清理用。 */
  clear(): void {
    this.data = { version: 1, servers: {} }
  }
}
