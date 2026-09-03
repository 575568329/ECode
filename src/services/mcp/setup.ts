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
    /** 审阅修复（安全席 P1·二轮）：批准卡内容摘要——server 清单（name/类型/目标）+ 环境变量
     *  引用名（${VAR} 形态的展开源提示——http 型 headers 外传面在此可见，值不脱敏因只列键名） */
    summary?: string
    approve: () => Promise<void>
  }
}

export function setupMcp(
  config: Config,
  toolReg: ToolRegistry,
  logger?: { warn: (m: string) => void },
  opts: { cwd?: string; envFallback?: Record<string, string> } = {},
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

  const { entries, warnings: mergeWarnings } = mergeMcpServers(config.mcpServers, effectiveProject, opts.envFallback ?? {})
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
    // 审阅修复（安全席 P1·二轮）：批准卡摘要——展示时解析（approve 复用同份 entries=
    // 「批准即所见」，比批准后重读更严）。列**项目级** server 名/类型/目标 + ${VAR} 引用名
    //（http 型 headers 的密钥外传面可见——原卡只显示文件路径，用户盲批即外传）
    const { entries: displayEntries, warnings: w2 } = mergeMcpServers(config.mcpServers, projectRaw, opts.envFallback ?? {})
    warnings.push(...w2)
    const projectNames = new Set(Object.keys(projectRaw))
    const varRefs = new Set<string>()
    const collectVars = (v: unknown): void => {
      if (typeof v === 'string') for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) varRefs.add(m[1] ?? '')
      if (Array.isArray(v)) v.forEach(collectVars)
      if (v !== null && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collectVars(x)
    }
    collectVars(projectRaw) // 变量引用从项目文件原文收（用户级 config 的不属本门审批面）
    const projectEntries = displayEntries.filter((e) => projectNames.has(e.name))
    const summaryParts = projectEntries.map((e) => {
      const host = e.cfg.type === 'http' && e.cfg.url !== undefined ? `→${safeHost(e.cfg.url)}` : ''
      return `${e.name}(${e.cfg.type}${host})`
    })
    if (varRefs.size > 0) summaryParts.push(`环境变量引用：${[...varRefs].slice(0, 6).join('、')}${varRefs.size > 6 ? ' 等' : ''}`)
    result.pendingApproval = {
      file: projectFile,
      summary: summaryParts.join('；').slice(0, 200),
      approve: async () => {
        const currentHash = mcpFileHash(projectFile)
        if (currentHash !== displayHash) {
          throw new Error(`${projectFile} 内容在批准前已变化（展示与批准时不一致），已拒绝接入——请重启 ECode 重新确认`)
        }
        approveMcpFile(projectFile)
        // 批准即所见：接入展示时解析的 entries（approve 与重读间再变不生效——原 loadProjectMcpJson
        // 重读引入「批准的是 A、接入的是 B」毫秒窗，TOCTOU 单次读收口）
        await manager.start(displayEntries) // 二段：追加 entries（start 按 name diff，已有用户级连接不重建）
      },
    }
  }
  return result
}

/** url → host（解析失败回原串截断——摘要展示用，不 throw） */
function safeHost(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return u.slice(0, 40)
  }
}
