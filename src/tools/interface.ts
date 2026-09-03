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
  /** F-39：本条调用的 tool_use id（loop 在 executeTool 包装注入——bash 超限落盘文件名/审计锚） */
  toolUseId?: string
  /** F-39：输出截断阈值（config `bashMaxOutputBytes` 经宿主装配填入——接线悬空修复；
   *  缺省回落工具内置缺省值） */
  maxOutputBytes?: number
  /**
   * M9-P1：写前快照回调（checkpoint 装配；心脏侧不认识 checkpoint 概念）。
   * 副作用工具 execute 开头调用（loop 层 readonly:false 确认已通过——execute 被调即已确认）。
   * write/edit 传目标绝对路径；bash 传空数组（命令不可解析，由服务端 git status 近修改集兜底）。
   * toolUseId 由 loop 在 executeTool 里包装注入（数据透传非逻辑——/rewind 投影锚用）。
   * 工具侧 catch：快照失败不阻断主流程（安全网自身的问题不挡写入）。
   */
  onBeforeWrite?: (paths: string[], tool: string, toolUseId?: string) => Promise<void>
  /**
   * 二轮审阅（架构席 P2 补遗）：bash 执行后 absent 兜底钩子——bash 不可解析目标，执行前
   * git status 近修改集拍不到「执行中新建」的文件（revert 无从删）；执行后差集补 absent
   * 基线进最近快照点。由宿主桥接 checkpoint（工具侧零依赖）。
   */
  /** 二轮补遗+实施审阅修复（bash absent 兑底）：基线实例化对——begin 拍写前快照记 seq 锚，end 差集补 absent 进锚点（不落共享槽） */
  bashBaselineBegin?: () => Promise<{ sessionId: string; pre: string[]; seq: number | null } | null>
  bashBaselineEnd?: (b: { sessionId: string; pre: string[]; seq: number | null } | null) => Promise<void>
  /**
   * M12-B4（D5）：宿主会话引用（HostSession 窄接口——结构类型，工具侧按需判读）。
   * 多会话并发（serve 多项目/双 HostSession）时，会话级状态（后台任务表/子代理进度）经此解析；
   * 缺省 undefined=单会话兜底走模块级（argv/旧测试路径），心脏只透传不认识会话。
   */
  session?: {
    /** 会话级后台任务表（bash run_in_background/task_output/task_stop） */
    tasks?: import('../services/tasks.js').TaskRegistry
    /** 会话级子代理进度（task 工具执行期上报；startedAt=总时长起点，waitingSince=LLM 等待起点） */
    updateSubagent?(st: { id: string; description: string; activity: string; startedAt?: number; waitingSince?: number }): void
    removeSubagent?(id: string): void
    /** 审阅修复批：运行中子代理计数（task 工具并发闸门 MAX_CONCURRENT_SUBAGENTS 的宿主权威源） */
    getActiveSubagentCount?(): number
    /** B8.2：子代理 confirm 会话化（多宿主不串台——模块级桥降为单会话兜底） */
    confirmTool?(use: import('../core/types.js').ToolUseBlock): Promise<boolean | string>
    /** M12-P0 审阅 P1-4：子代理 usage 经会话窄端口归账（多宿主不串台；模块桥降兜底） */
    recordUsage?(inputTokens: number, outputTokens: number, cache?: { read?: number; creation?: number }): void
    /** M12-P0 审阅 P1-2：子代理发起的 mcp__ 调用计数 */
    countMcpCall?(): void
    /** B8.2：ask_user 会话化（argv/多宿主 fail-closed 语义由宿主 broker 决定） */
    askUser?(questions: unknown[]): Promise<unknown>
    /** M13-W1：skill hooks 写端口（项目级 registry 绑定——多项目 /clear 不串台；缺省走模块兑底端口） */
    skillHooks?: import('../services/hooks/global.js').SkillHooksPort
    /** M13 审阅 R1：子代理写前快照会话化（多会话下 checkpoint 归属发起会话——模块桥最后挂载者不再误导向） */
    onBeforeWrite?(paths: string[], tool: string, toolUseId?: string): Promise<void>
    /** 二轮补遗：bash absent 兜底（子代理 bash 同享主会话 checkpoint） */
    /** 二轮补遗+实施审阅修复（bash absent 兑底）：基线实例化对——begin 拍写前快照记 seq 锚，end 差集补 absent 进锚点（不落共享槽） */
    bashBaselineBegin?: () => Promise<{ sessionId: string; pre: string[]; seq: number | null } | null>
    bashBaselineEnd?: (b: { sessionId: string; pre: string[]; seq: number | null } | null) => Promise<void>
    /** M13 审阅 R1：子代理沙箱档随发起会话（sandbox/set 切档后子代理跟随本会话档位） */
    getSandbox?(): import('../services/sandbox.js').Sandbox
    /** 审阅 P0-3：运行态四 getter 会话化（模块桥单槽是进程级，serve 多项目被后启动项目
     *  覆盖——先挂项目的子代理曾用错项目的 provider/model/摘要角色；窄端口随身携带正确宿主） */
    getProviderReq?(): import('../providers/interface.js').ProviderReq
    getProvider?(): import('../providers/interface.js').LLMProvider
    getModel?(): string
    getSummaryRole?(): Promise<import('../services/compaction/hook.js').SummaryRole | null>
    /** 审阅 P1-4：发起会话 id（hook 事件 session_id 与权限 asker 键的路由依据——项目级
     *  sessionRef 是"最后 ensure 者胜"，多会话下会错向别会话的 broker） */
    getSessionId?(): string
    /** M13-B1：skill 激活判定（扫投影后 messages——/rewind·压缩后标记被投影自动回未激活） */
    isSkillActive?(name: string): boolean
    /** M13-B1：重复读守卫（mtime 比对；write/edit 后 mtime 变自然放行——bash cat 是逃生口 D6） */
    readFileGuard?: {
      check(path: string): Promise<boolean>
      record(path: string): Promise<void>
    }
  }
  /** M12-B4：会话级后台任务表快捷位（ctx.session.tasks 的平铺——工具侧免嵌套判空） */
  tasks?: import('../services/tasks.js').TaskRegistry

  /**
   * M9-P4：沙箱（undefined=未装配如测试；工具 execute 前置校验——心脏只透传不认识模式）。
   * write/edit 用 checkWrite；bash 用 checkBash（deny 才拦，confirm/allow 由 loop confirm 层处理）。
   */
  sandbox?: import('../services/sandbox.js').Sandbox
  /**
   * M10-P0：当前模型名（宿主装配注入）。曾用于 read_file 读图前的 isVisionModel 名门，
   * 2026-08-29 拍板拆除（名单必滞后，glm-5.3-flash 误拦实证）——图片恒直传由端点自证；
   * 字段保留：工具侧按模型名做其他能力分支时的现成入口。
   */
  model?: string
  /**
   * 敏感访问确认（安全审阅 P0）：工具自行判断何时调用（如 read_file 命中密钥类路径），
   * 返回 true 才放行。由上层注入（TUI 弹窗）；无此回调 = 当前模式无法确认
   * （argv 无头等）→ 工具侧 fail-closed 拒绝（宁拦勿泄）。心脏只透传不认识「敏感」。
   */
  confirmSensitive?: (description: string) => Promise<boolean | string>
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
   * recoverable 错误，不强杀后台 execute）。现存用户：MCP 工具（adapt 按 server config
   * 注入）。bash 自管超时（timeout_ms 输入参数，2026-09-03 等待根治——超时自杀树）；
   * task 子代理无超时（轮数上限+Ctrl+C 防御，硬超时已废）——两者均不声明本字段。
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
