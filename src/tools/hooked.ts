/**
 * HookedToolRegistry：PreToolUse/PostToolUse 的装饰接入（H4，M7-D11）。
 *
 * 心脏零改动：loop 依赖 ToolRegistry 接口，拿到的本类是代理——get() 返回包装 Tool
 * （execute = PreToolUse → block 则 is_error / 改参 → inner.execute → PostToolUse 附加
 * context），其余方法直通 inner。
 *
 * H4 v3.1 实现约束：对 HookRunner 的引用必须经 getter（getRunner），禁止闭包捕获实例
 * ——hooks 原子重建（clear-then-register）后，装饰层下一次执行自动用新 runner；
 * 捕获旧实例会导致 Pre/PostToolUse 静默执行旧集合（无报错的失效）。
 */

import type { HookRunner } from '../services/hooks/runner.js'
import type { Tool, ToolContext, ToolRegistry, ToolResult } from './interface.js'

/** PostToolUse 附加 context 的最大长度（防 hook 输出撑爆 tool_result / 上下文预算）。 */
const ATTACH_LIMIT = 8_000

export class HookedToolRegistry implements ToolRegistry {
  private readonly inner: ToolRegistry
  private readonly getRunner: () => HookRunner | null

  constructor(inner: ToolRegistry, getRunner: () => HookRunner | null) {
    this.inner = inner
    this.getRunner = getRunner
  }

  register(t: Tool): void {
    this.inner.register(t)
  }

  unregister(name: string): void {
    this.inner.unregister(name)
  }

  get(name: string): Tool | undefined {
    const tool = this.inner.get(name)
    if (tool === undefined) return undefined
    // 重校验通路（安全审阅 P1）：PreToolUse 的 updatedInput 在用户确认后替换入参，必须重过
    // registry 同款 validate（AJV；skipLocalValidate 的外部工具保持透传语义）
    return wrapTool(tool, this.getRunner, (input) => this.inner.validate(name, input))
  }

  specs(): ReturnType<ToolRegistry['specs']> {
    return this.inner.specs()
  }

  /** M11-P2：直通（子代理裁剪现取经代理拿全量） */
  list(): Tool[] {
    return this.inner.list()
  }

  validate(name: string, input: unknown): { ok: true } | { ok: false; error: string } {
    return this.inner.validate(name, input)
  }
}

/** 单工具包装：execute 前后挂 hook 事件，其余元数据（name/schema/readonly）直通。 */
function wrapTool(
  tool: Tool,
  getRunner: () => HookRunner | null,
  revalidate: (input: unknown) => { ok: true } | { ok: false; error: string },
): Tool {
  return {
    ...tool,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const runner = getRunner()
      if (runner === null) return tool.execute(args, ctx)

      // PreToolUse：block → is_error（recoverable，LLM 自纠）；updatedInput → 整体替换入参
      // M9-P0：verdict 全字段消费——block 时 additionalContext/systemMessages 一并展示；
      // 非阻塞 context 注入成功 tool_result（结果前缀，LLM 同轮可见）；dispatch 透传 ctx.signal
      let preAttach: string[] = []
      if (runner.hasHandlers('PreToolUse')) {
        const pre = await runner.dispatch(
          'PreToolUse',
          {
            event: 'PreToolUse',
            session_id: '',
            tool_name: tool.name,
            tool_input: args,
          },
          { signal: ctx.signal },
        )
        if (pre.block) {
          const extra = [...pre.additionalContext, ...pre.systemMessages.map((m) => `[hook] ${m}`)]
          return {
            content:
              `hook blocked：${pre.reason !== undefined && pre.reason !== '' ? pre.reason : '工具调用被 hook 拦截'}` +
              (extra.length > 0 ? `\n\n[hook context]\n${extra.join('\n')}` : ''),
            is_error: true,
          }
        }
        if (pre.updatedInput !== undefined) {
          // 安全审阅 P1：hook 在用户确认**之后**替换工具入参，若不再过校验，确认界面展示的
          // 与实际执行的可以不一致（插件滥用面）。替换后重过 registry 同款校验（AJV），
          // 失败 → recoverable is_error 拒绝执行（LLM 自纠），不进原工具。
          args = pre.updatedInput
          const v = revalidate(args)
          if (!v.ok) {
            return {
              content: `hook 替换后的工具入参校验失败，已拒绝执行（确认时展示的入参可能与被替换后的不一致）：${v.error}`,
              is_error: true,
            }
          }
        }
        preAttach = [...pre.additionalContext, ...pre.systemMessages.map((m) => `[hook] ${m}`)]
      }

      let result = await tool.execute(args, ctx)
      if (preAttach.length > 0) {
        result = { ...result, content: `[hook context]\n${preAttach.join('\n').slice(0, ATTACH_LIMIT)}\n\n${result.content}` }
      }

      // PostToolUse：additionalContext 追加到结果（LLM 可见，下一轮生效）；systemMessage 同途
      //（MVP 不建独立 systemMsgs 通道——TuiApp 层事件才走底部提示）
      if (runner.hasHandlers('PostToolUse')) {
        const post = await runner.dispatch(
          'PostToolUse',
          {
            event: 'PostToolUse',
            session_id: '',
            tool_name: tool.name,
            tool_input: args,
            tool_result: { content: result.content.slice(0, ATTACH_LIMIT), is_error: result.is_error },
          },
          { signal: ctx.signal },
        )
        const attach = [
          ...post.additionalContext,
          ...post.systemMessages.map((m) => `[hook] ${m}`),
        ]
        if (attach.length > 0) {
          return { ...result, content: `${result.content}\n\n${attach.join('\n').slice(0, ATTACH_LIMIT)}` }
        }
      }
      return result
    },
  }
}
