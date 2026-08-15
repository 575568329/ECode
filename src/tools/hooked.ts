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
    return wrapTool(tool, this.getRunner)
  }

  specs(): ReturnType<ToolRegistry['specs']> {
    return this.inner.specs()
  }

  validate(name: string, input: unknown): { ok: true } | { ok: false; error: string } {
    return this.inner.validate(name, input)
  }
}

/** 单工具包装：execute 前后挂 hook 事件，其余元数据（name/schema/readonly）直通。 */
function wrapTool(tool: Tool, getRunner: () => HookRunner | null): Tool {
  return {
    ...tool,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const runner = getRunner()
      if (runner === null) return tool.execute(args, ctx)

      // PreToolUse：block → is_error（recoverable，LLM 自纠）；updatedInput → 整体替换入参
      if (runner.hasHandlers('PreToolUse')) {
        const pre = await runner.dispatch('PreToolUse', {
          event: 'PreToolUse',
          session_id: '',
          tool_name: tool.name,
          tool_input: args,
        })
        if (pre.block) {
          return {
            content: `hook blocked：${pre.reason !== undefined && pre.reason !== '' ? pre.reason : '工具调用被 hook 拦截'}`,
            is_error: true,
          }
        }
        if (pre.updatedInput !== undefined) args = pre.updatedInput
      }

      const result = await tool.execute(args, ctx)

      // PostToolUse：additionalContext 追加到结果（LLM 可见，下一轮生效）；systemMessage 同途
      //（MVP 不建独立 systemMsgs 通道——TuiApp 层事件才走底部提示）
      if (runner.hasHandlers('PostToolUse')) {
        const post = await runner.dispatch('PostToolUse', {
          event: 'PostToolUse',
          session_id: '',
          tool_name: tool.name,
          tool_input: args,
          tool_result: { content: result.content.slice(0, ATTACH_LIMIT), is_error: result.is_error },
        })
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
