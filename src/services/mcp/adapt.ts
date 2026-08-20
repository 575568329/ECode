/**
 * MCP 适配层（M6 M3.3/M4.2/M4.4/M-P3）：SDK 连接工厂 + adaptTool + renderContent + normalizeSchema。
 *
 * - createSdkConnectFn：生产连接器（stdio spawn / Streamable HTTP 握手 → ClientLike 包装）
 * - adaptTool：MCP tool def → ECode Tool（mcp__server__tool 命名 / readonly=false 默认确认 /
 *   skipLocalValidate 透传 server 校验 / getClient 惰性句柄——execute 时才 lazyConnect）
 * - 传输层错误 → markBroken（死连接降级：清句柄置 failed，下次调用自动重连）
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool, ToolResult, ToolContext } from '../../tools/interface.js'
import type { McpManager, McpClientLike, McpContentItem } from './manager.js'
import type { McpServerConfig } from './config.js'
import type { McpToolDef } from './cache.js'

const ECODE_VERSION = '0.1.0'
const DEFAULT_TIMEOUT_MS = 30_000
/** 传输层错误特征（markBroken 判定；收紧——closed/pipe 等泛词会误匹配业务错误触发 60s 退避）。 */
const TRANSPORT_ERROR_RE = /ECONNRESET|EPIPE|EDISCONNECTED|ERR_STREAM|socket hang up|not initialized|session expired|transport closed/i

/** npx 类命令在 win32 需要 shell 包裹（.cmd 文件 Node 不能直接 spawn）；其余命令原样。
 *  导出供单测（全项目最易错的平台代码，审阅 P1：不可测=改不了）。 */
export function spawnSpec(cfg: McpServerConfig): { command: string; args: string[]; shell?: boolean } {
  const args = cfg.args ?? []
  if (process.platform === 'win32' && /^(npx|npm|pnpm|yarn|bunx)(\.cmd)?$/i.test(cfg.command ?? '')) {
    return { command: 'cmd', args: ['/c', cfg.command ?? '', ...args] }
  }
  return { command: cfg.command ?? '', args }
}

/** 密钥形态环境变量 deny-list（安全审阅 P1）：stdio MCP server 可能来自项目级 .mcp.json 的
 *  第三方代码，不该整份继承宿主 env——dotenv 注入的 ANTHROPIC_API_KEY 等会原样透传给任意
 *  server 进程。选 deny-list 而非白名单：各 server 对环境变量的依赖无法穷举（PATH/SSL/locale/
 *  语言运行时…），白名单对各 server 依赖太脆；deny-list 封密钥外泄为主，普通变量保留。
 *  按下划线分段匹配（(^|_)KEY(_|$)）：AWS_ACCESS_KEY_ID（_KEY_ 段）、GH_PAT、MYSQL_PASS、
 *  DB_PW 这类不含完整关键词的变体也命中；PUBLIC_KEY 类公钥变量会被一并剔除——公钥非密钥，
 *  但 server 确需时可在 cfg.env 显式配置（显式配置不受过滤且优先覆盖）。
 *  cfg.env 是用户显式配置（含 ${ENV_VAR} 占位符展开后的值），不受过滤且优先覆盖。 */
const SECRET_ENV_KEY_RE = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|PW|PAT|CRED(S|ENTIAL)?S?|COOKIE)(_|$)/i

/** 单键判定：snake_case 直接分段匹配；camelCase（MyToken/myApiKey 类）先折算成
 *  下划线分段再匹配——Windows env 键风格不定，两种边界都吃。 */
function isSecretEnvKey(key: string): boolean {
  if (SECRET_ENV_KEY_RE.test(key)) return true
  const camelSplit = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SECRET_ENV_KEY_RE.test(camelSplit)
}

/** 过滤后的继承环境（导出供单测，spawnSpec 同款惯例）。 */
export function sanitizedProcessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (isSecretEnvKey(k)) continue
    out[k] = v
  }
  return out
}

/** SDK Client → ClientLike（callTool 的 signal/timeout 透传 + resetTimeoutOnProgress）。 */
function wrapSdkClient(client: Client, transport: StdioClientTransport | StreamableHTTPClientTransport, defaultTimeoutMs: number): McpClientLike {
  return {
    listTools: async () => {
      const r = await client.listTools()
      return { tools: r.tools as unknown as McpToolDef[] }
    },
    callTool: async (params, opts) => {
      const r = await client.callTool(
        { name: params.name, arguments: (params.arguments ?? {}) as Record<string, unknown> },
        undefined,
        {
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
          timeout: opts?.timeout ?? defaultTimeoutMs,
          resetTimeoutOnProgress: true,
        },
      )
      return r as unknown as { content: McpContentItem[]; isError?: boolean }
    },
    close: () => client.close(),
    // 同步杀（进程退出兜底）：SDK close() 是异步链（stdin.end → 2s → SIGTERM → 2s → SIGKILL），
    // exit 回调里事件循环即将停止只跑得到第一段——stdio 子进程不响应 stdin 关闭即孤儿。
    // 直接同步 kill transport 的子进程（_process 是 SDK 内部字段，^1.30 内稳定；SDK 公开后再换）。
    killNow: () => {
      const proc = (transport as unknown as { _process?: { kill(signal?: string): void } })._process
      proc?.kill('SIGKILL')
    },
  }
}

/** 生产连接器（stdio/HTTP 握手 + 超时兜底）。 */
export function createSdkConnectFn(): (name: string, cfg: McpServerConfig, signal?: AbortSignal) => Promise<McpClientLike> {
  return async (_name, cfg, signal) => {
    const timeoutMs = cfg.timeout ?? DEFAULT_TIMEOUT_MS
    let transport: StdioClientTransport | StreamableHTTPClientTransport
    if (cfg.type === 'stdio') {
      const spec = spawnSpec(cfg)
      transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
        env: { ...sanitizedProcessEnv(), ...(cfg.env ?? {}) } as Record<string, string>,
        stderr: 'pipe', // 不静默吞子进程 stderr（调试通道；MVP 不转发，后续接 LogStore）
        ...(signal !== undefined ? { signal } : {}),
      })
    } else {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url ?? ''), {
        requestInit: { headers: cfg.headers ?? {} },
        ...(signal !== undefined ? { signal } : {}),
      })
    }
    const client = new Client({ name: 'ecode', version: ECODE_VERSION })
    // 超时 race 双泄漏修复（审阅 P1）：定时器必须清理（否则拖延进程退出）；
    // 超时路径要显式 close（connect 可能仍在后台成功 → transport/stdio 子进程成孤儿）
    let raceTimer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, rej) => {
          raceTimer = setTimeout(() => rej(new Error(`MCP 连接超时（${timeoutMs}ms）`)), timeoutMs)
        }),
      ])
    } catch (e) {
      await client.close().catch(() => {})
      throw e
    } finally {
      if (raceTimer !== undefined) clearTimeout(raceTimer)
    }
    return wrapSdkClient(client, transport, timeoutMs)
  }
}

/** 工具名净化（跨 server 冲突防线：非法字符 → -）。 */
export function sanitizeToolName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
}

/**
 * 外部 schema 归一化（v3 P1-2）：MCP server 给的是 draft-2020-12 原始 schema
 * （$defs/外部 $ref/oneOf），直发违反扁平化约束且可能让消费方炸——
 * 剥 $defs、$ref 节点降级 string、oneOf/anyOf 键丢弃、properties 上限 64。
 */
export function normalizeSchema(schema: object | undefined): object {
  if (schema === undefined || typeof schema !== 'object') return { type: 'object', properties: {} }
  return normalizeNode(schema, 0) as object
}

const MAX_SCHEMA_DEPTH = 8
const MAX_PROPERTIES = 64

function normalizeNode(node: unknown, depth: number): unknown {
  // 原语（type:'string' 的值等）原样通过；只有过深才折叠
  if (node === null || typeof node !== 'object') return node
  if (depth > MAX_SCHEMA_DEPTH) return { type: 'string', description: '（结构过深已折叠）' }
  if (Array.isArray(node)) return node.map((n) => normalizeNode(n, depth + 1))
  const src = node as Record<string, unknown>
  if (typeof src['$ref'] === 'string') {
    return { type: 'string', description: `（原为复杂引用：${String(src['$ref']).slice(0, 40)}，按需传 JSON 字符串或对象）` }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === '$defs' || k === '$id' || k === '$schema') continue // 剥定义区与元键
    if (k === 'oneOf' || k === 'anyOf' || k === 'allOf' || k === 'not') continue // 复合降级：丢弃，保底字段仍传
    if (k === 'properties' && v !== null && typeof v === 'object') {
      const props = Object.entries(v as Record<string, unknown>).slice(0, MAX_PROPERTIES)
      out['properties'] = Object.fromEntries(props.map(([pk, pv]) => [pk, normalizeNode(pv, depth + 1)]))
      continue
    }
    out[k] = normalizeNode(v, depth + 1)
  }
  return out
}

/** tools/call content[] → 文本（text 原样 / image 占位 / resource_link 路径 / resource 内容）。 */
export function renderContent(items: McpContentItem[] | undefined): string {
  if (items === undefined || items.length === 0) return '（无内容返回）'
  const parts: string[] = []
  for (const it of items) {
    switch (it.type) {
      case 'text':
        parts.push(it.text ?? '')
        break
      case 'image':
        parts.push(`[图片 ${it.mimeType ?? 'binary'} ${(it.data ?? '').length} 字节]`)
        break
      case 'resource_link':
        parts.push(`[资源] ${it.uri ?? ''}`)
        break
      case 'resource':
        parts.push(it.text ?? (it.blob !== undefined ? `[二进制资源 ${it.uri ?? ''}]` : `[资源] ${it.uri ?? ''}`))
        break
      default:
        parts.push(`[${it.type}]`)
    }
  }
  return parts.filter((p) => p !== '').join('\n') || '（无内容返回）'
}

/** MCP tool def → ECode Tool（M3.3）。 */
export function adaptTool(
  serverName: string,
  def: McpToolDef,
  manager: McpManager,
  cfg: McpServerConfig,
): Tool {
  const timeoutMs = cfg.timeout ?? DEFAULT_TIMEOUT_MS
  const prefixedName = `mcp__${sanitizeToolName(serverName)}__${sanitizeToolName(def.name)}`
  return {
    name: prefixedName,
    description: def.description ?? `MCP tool ${def.name}（server: ${serverName}）`,
    input_schema: normalizeSchema(def.inputSchema),
    readonly: false, // 默认每次确认（D12：annotations 不可信，第三方代码）
    skipLocalValidate: true, // 透传 server 校验（D13）
    timeout_ms: timeoutMs,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      manager.beginCall(serverName)
      try {
        const client = await manager.getClientFor(serverName, ctx.signal)
        // M9-P1 覆盖面补齐：MCP 工具入参里的路径不可信（第三方代码），快照走 bash 同款
        // 近修改集兜底（onBeforeWrite 空数组 → git status）；失败不挡主流程（与内置工具一致）
        try {
          await ctx.onBeforeWrite?.([], prefixedName)
        } catch {
          /* 快照失败静默继续（装配方 warn 已记） */
        }
        const r = await client.callTool({ name: def.name, arguments: args }, { signal: ctx.signal, timeout: timeoutMs })
        return { content: renderContent(r.content), is_error: r.isError === true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 传输层错误 → 死连接降级（清句柄置 failed，下次调用自动重连；本次 is_error 回喂 LLM 自纠）
        if (TRANSPORT_ERROR_RE.test(msg)) manager.markBroken(serverName, msg)
        if (ctx.signal.aborted) throw e // 用户中断走 aborted 路径（loop 固化已产出）
        return { content: `MCP 工具 ${def.name} 执行失败：${msg}`, is_error: true }
      } finally {
        manager.endCall(serverName)
      }
    },
  }
}
