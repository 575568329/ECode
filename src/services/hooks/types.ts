/**
 * hooks 类型（M7 H-P1，详设 M7 §H1-H3）。
 *
 * 双源模型：用户源（config.json `hooks` 键）+ 扩展源（ExtensionHooksRegistry 内存注册表），
 * 两源同构 HookSpec[]，分发时合并——扩展 hooks 永不写 config（分层铁律 M7-D10）。
 *
 * 事件集 MVP 六个（H2）；执行体 MVP 仅 command（H3，mcp_tool/prompt 接口位预留不实现）。
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/** 执行体。MVP 仅 command；mcp_tool/prompt 为后置形态接口位（用户拍板 mcp_tool 不做）。 */
export type HookHandler =
  | {
      kind: 'command'
      command: string
      /** Windows 覆盖（H3）：win32 下优先使用（如平台特定脚本） */
      command_windows?: string
      timeout_ms?: number
      async?: boolean
    }
  | { kind: 'mcp_tool'; server: string; tool: string; input: object }
  | { kind: 'prompt'; prompt: string }

/** 一条 hook 声明（两源同构）。 */
export interface HookSpec {
  event: HookEvent
  /** 工具事件的可选匹配（工具名，支持 | 列表与正则；MCP 工具 mcp__server__tool 同样可匹配） */
  matcher?: string
  handler: HookHandler
  /** 事件级超时（毫秒）；command 形态 handler 内还有自身 timeout_ms，取小者 */
  timeout_ms?: number
}

/** 喂给 hook 的 stdin JSON（H3 stdin 协议；字段按事件按需携带）。 */
export interface HookInput {
  event: HookEvent
  session_id: string
  /** SessionStart：startup | resume */
  source?: 'startup' | 'resume'
  /** UserPromptSubmit：用户输入原文 */
  prompt?: string
  /** Pre/PostToolUse */
  tool_name?: string
  tool_input?: unknown
  /** PostToolUse：工具结果摘要 */
  tool_result?: { content: string; is_error?: boolean }
  /** Stop：结束原因 */
  stop_reason?: string
}

/** hook 的 stdout JSON 协议（H3；全部字段可选，无输出=纯通知）。 */
export interface HookOutput {
  /** false = block（PreToolUse 阻断工具；UserPromptSubmit 拦截输入） */
  continue?: boolean
  /** PreToolUse 改入参（整体替换 tool_input） */
  updatedInput?: unknown
  /** PostToolUse/UserPromptSubmit：附加上下文注入下一轮 */
  additionalContext?: string
  /** 显示给用户的提示（systemMsgs） */
  systemMessage?: string
  /** block 时的人类可读理由 */
  reason?: string
}

/** 一轮事件的分发裁决（多 hook 聚合；fail-open——执行失败不产生 block）。 */
export interface HookVerdict {
  block: boolean
  reason?: string
  updatedInput?: unknown
  additionalContext: string[]
  systemMessages: string[]
}

/** 执行器抽象（H-P2 实现；注入便于测试）。返回 null = 无 stdout JSON（纯通知）。 */
export type HookExecutor = (
  spec: HookSpec,
  input: HookInput,
  opts?: { signal?: AbortSignal },
) => Promise<HookOutput | null>
