/**
 * MCP 启动接线（M6 M-P9）：config + .mcp.json → McpManager + 工具注册 + 首用批准二段启动。
 *
 * 流程（M4.1）：
 *   1. 用户级 config.mcpServers + 已批准的项目级 .mcp.json → mergeMcpServers
 *   2. manager.start（cache 命中注册零连接；eager/keep-alive 即连）
 *   3. 项目级未批准 → pendingApproval 返回（TuiApp 弹批准 overlay；批准后 approve() 二段接入）
 * onTools 钩子把 defs 经 adaptTool 注册进 ToolRegistry（工具数超阈值 warn）。
 */

import type { ToolRegistry } from '../../tools/interface.js'
import type { Config } from '../config.js'
import { McpManager } from './manager.js'
import { McpCache } from './cache.js'
import { adaptTool, createSdkConnectFn } from './adapt.js'
import {
  findProjectMcpJson,
  loadProjectMcpJson,
  isMcpApproved,
  approveMcpFile,
  mcpFileHash,
  mergeMcpServers,
} from './config.js'

/** 单 server 工具数超此值 warn（M3.4 超阈值提示）。 */
const TOOLS_WARN_THRESHOLD = 20

export interface McpSetupResult {
  manager: McpManager
  warnings: string[]
  /** 项目级 .mcp.json 待批准（TuiApp 弹 overlay；approve() 后二段接入） */
  pendingApproval?: {
    file: string
    approve: () => Promise<void>
  }
}

export function setupMcp(
  config: Config,
  toolReg: ToolRegistry,
  logger?: { warn: (m: string) => void },
  opts: { cwd?: string } = {},
): McpSetupResult {
  const warnings: string[] = []
  const projectFile = findProjectMcpJson(opts.cwd ?? process.cwd())
  const projectRaw = projectFile !== null ? loadProjectMcpJson(projectFile) : null
  if (projectFile !== null && projectRaw === null) {
    warnings.push(`项目级 ${projectFile} 解析失败，已忽略`)
  }
  // 首用批准（v3 P1-4）：未批准 → 本轮只上用户级；TuiApp 批准后二段接入
  const projectApproved = projectFile !== null && projectRaw !== null && isMcpApproved(projectFile)
  const effectiveProject = projectApproved ? (projectRaw ?? undefined) : undefined
  if (projectFile !== null && projectRaw !== null && !isMcpApproved(projectFile)) {
    warnings.push(`检测到项目级 ${projectFile}，需要批准后才会连接（防克隆恶意仓库静默 spawn）`)
  }

  const { entries, warnings: mergeWarnings } = mergeMcpServers(config.mcpServers, effectiveProject)
  warnings.push(...mergeWarnings)

  const cache = new McpCache()
  const manager = new McpManager({
    connectFn: createSdkConnectFn(),
    cache,
    onTools: (serverName, defs, cfg) => {
      for (const def of defs) {
        toolReg.register(adaptTool(serverName, def, manager, cfg))
      }
      if (defs.length > TOOLS_WARN_THRESHOLD) {
        const w = `MCP server「${serverName}」工具数 ${defs.length} 偏多（schema 占上下文，已计入压缩估算）`
        warnings.push(w)
        logger?.warn(w)
      }
    },
  })

  // 启动异步进行（cache 注册零连接；失败走状态机不阻塞 TUI）
  void manager
    .start(entries)
    .then(({ connected, failed }) => {
      if (entries.length > 0) {
        logger?.warn(`MCP 启动：${connected}/${entries.length} 已连接${failed.length > 0 ? `（失败：${failed.join(', ')}）` : ''}`)
      }
    })
    .catch(() => {})

  const result: McpSetupResult = { manager, warnings }
  if (projectFile !== null && projectRaw !== null && !isMcpApproved(projectFile)) {
    // 展示时指纹：approve 时重算比对（TOCTOU 防护，审阅 P1——批准间隙文件被换则拒绝并要求重启确认）
    const displayHash = mcpFileHash(projectFile)
    result.pendingApproval = {
      file: projectFile,
      approve: async () => {
        const currentHash = mcpFileHash(projectFile)
        if (currentHash !== displayHash) {
          throw new Error(`${projectFile} 内容在批准前已变化（展示与批准时不一致），已拒绝接入——请重启 ECode 重新确认`)
        }
        approveMcpFile(projectFile)
        // 重读接入（不用启动时快照——approve 与读取间再变也以批准时内容为准）
        const fresh = loadProjectMcpJson(projectFile)
        const { entries: full, warnings: w2 } = mergeMcpServers(config.mcpServers, fresh ?? undefined)
        warnings.push(...w2)
        await manager.start(full) // 二段：追加 entries（start 按 name diff，已有用户级连接不重建）
      },
    }
  }
  return result
}
