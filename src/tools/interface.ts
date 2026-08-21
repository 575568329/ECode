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
   * M12-B4（D5）：宿主会话引用（HostSession 窄接口——结构类型，工具侧按需判读）。
   * 多会话并发（serve 多项目/双 HostSession）时，会话级状态（后台任务表/子代理进度）经此解析；
   * 缺省 undefined=单会话兜底走模块级（argv/旧测试路径），心脏只透传不认识会话。
   */
  session?: {
    /** 会话级后台任务表（bash run_in_background/task_output/task_stop） */
    tasks?: import('../services/tasks.js').TaskRegistry
    /** 会话级子代理进度（task 工具执行期上报） */
    updateSubagent?(st: { id: string; description: string; activity: string }): void
    removeSubagent?(id: string): void
  }
  /** M12-B4：会话级后台任务表快捷位（ctx.session.tasks 的平铺——工具侧免嵌套判空） */
  tasks?: import('../services/tasks.js').TaskRegistry

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
  /**
   * 敏感访问确认（安全审阅 P0）：工具自行判断何时调用（如 read_file 命中密钥类路径），
   * 返回 true 才放行。由上层注入（TUI 弹窗）；无此回调 = 当前模式无法确认
   * （argv 无头等）→ 工具侧 fail-closed 拒绝（宁拦勿泄）。心脏只透传不认识「敏感」。
   */
  confirmSensitive?: (description: string) => Promise<boolean>
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema（扁平化：type + properties + required + 基础约束） */
  input_schema: object
  /** true=只读（可并行、免确认）/ false=有副作用（串行、需确认） */
  readonly: boolean
  /**
   * 可选：执行超时（毫秒）。声明了才由循环统一强制（软超时——超时放弃等待转
   * recoverable 错误，不强杀后台 execute）；未声明则不设限（bash/task 等长任务自管超时）。
   */
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
  /**
   * 全量 Tool 对象（M11-P2：子代理裁剪 Registry 现取现建用——specs 不含 readonly/execute
   * 无法重建；快照与运行期注册的漂移可接受：下个子代理现取即收敛）
   */
  list(): Tool[]
  /** AJV 校验：不通过直接返回 ok:false（loop 转 is_error 的 ToolResult，根本不进 Tool） */
  validate(name: string, input: unknown): { ok: true } | { ok: false; error: string }
}
