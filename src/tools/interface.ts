/**
 * Tool 接口（工具能力分支面）。
 *
 * 详设 §2.3。入参校验用 AJV（JSON Schema 原生，零转换）。
 * readonly 二分：true=只读（可并行、免确认）/ false=有副作用（串行、需确认）。
 * JSON Schema 扁平化（避开 oneOf/anyOf/$ref）—— GLM 对复杂 schema 支持度未知。
 */

import type { ToolSpec } from '../core/types.js'

export interface ToolResult {
  content: string
  is_error?: boolean
  /** M10-P0：多模态附着块（image/document）——read_file 读图/PDF 时带出，翻译层组装协议形态 */
  blocks?: Array<import('../core/types.js').ImageBlock | import('../core/types.js').DocumentBlock>
}

/** 注入给工具，工具无全局状态。M1 最小切片：cwd + signal（config/logger 留 M3/M4）。 */
export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /**
   * M9-P1：写前快照回调（checkpoint 装配；心脏侧不认识 checkpoint 概念）。
   * 副作用工具 execute 开头调用（loop 层 readonly:false 确认已通过——execute 被调即已确认）。
   * write/edit 传目标绝对路径；bash 传空数组（命令不可解析，由服务端 git status 近修改集兜底）。
   * toolUseId 由 loop 在 executeTool 里包装注入（数据透传非逻辑——/rewind 投影锚用）。
   * 工具侧 catch：快照失败不阻断主流程（安全网自身的问题不挡写入）。
   */
  onBeforeWrite?: (paths: string[], tool: string, toolUseId?: string) => Promise<void>
  /**
   * M9-P4：沙箱（undefined=未装配如测试；工具 execute 前置校验——心脏只透传不认识模式）。
   * write/edit 用 checkWrite；bash 用 checkBash（deny 才拦，confirm/allow 由 loop confirm 层处理）。
   */
  sandbox?: import('../services/sandbox.js').Sandbox
  /**
   * M10-P0：当前模型名（无视觉能力守卫——read_file 读图前查 isVisionModel）。
   * 宿主装配注入；缺省空串 = 拦截（fail-closed——无模型信息时不放行图片，宁拦勿错）。
   */
  model?: string
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema（扁平化：type + properties + required + 基础约束） */
  input_schema: object
  /** true=只读（可并行、免确认）/ false=有副作用（串行、需确认） */
  readonly: boolean
  /** 执行超时（默认 30s），超时转 recoverable 错误 */
  timeout_ms?: number
  /**
   * 外部工具（MCP）：跳过本地 AJV 校验/预编译，参数透传给 server 校验（M6-D13）。
   * server 是实现方最懂参数约束；且外部 schema（draft-2020-12/$ref/oneOf）可能让 AJV 编译直接 throw。
   */
  skipLocalValidate?: boolean
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolRegistry {
  register(t: Tool): void
  /** 注销（MCP server 断开后清理 / M7 plugin disable 卸载用；不存在时静默） */
  unregister(name: string): void
  get(name: string): Tool | undefined
  /** 导出给 LLMProvider 的 tools 参数 */
  specs(): ToolSpec[]
  /** AJV 校验：不通过直接返回 ok:false（loop 转 is_error 的 ToolResult，根本不进 Tool） */
  validate(name: string, input: unknown): { ok: true } | { ok: false; error: string }
}
