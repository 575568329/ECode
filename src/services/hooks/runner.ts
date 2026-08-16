/**
 * HookRunner：双源分发器（H1）。查询=合并用户源与扩展注册表按 event/matcher 过滤；
 * 执行=逐条调 executor 聚合裁决。
 *
 * 失败语义（H5，fail-open）：hook 是子进程 command，超时/崩溃的失败面大，若失败即阻断，
 * 辅助观测就成了主链路的单点故障；block 是显式决策（continue:false / exit 2），
 * 只与输出语义耦合，不与执行成败耦合。失败 → warn + 放行。
 */

import type { ExtensionHooksRegistry } from './registry.js'
import { matcherMatches } from './matcher.js'
import type { HookEvent, HookExecutor, HookInput, HookSpec, HookVerdict } from './types.js'

export interface HookRunnerDeps {
  /** 扩展源注册表（skill frontmatter / plugin hooks.json 的统一入口） */
  extensions: ExtensionHooksRegistry
  /** 执行器（H-P2 的 command 执行器；注入便于测试） */
  execute: HookExecutor
  /** 用户源快照（config.json hooks 键经 parseUserHooks 过滤后的结果） */
  getUserHooks?: () => HookSpec[]
  /** 执行失败/超时的告警通道（fail-open 只告警不阻断） */
  warn?: (message: string) => void
  /** 会话 id 集中注入（HookInput.session_id 的统一来源，调用方免逐处传递） */
  getSessionId?: () => string
  /**
   * M9-P5：扩展源 hook 权限门（spec.owner 存在才查——用户源不问）。false=deny 跳过（warn 告知）。
   * 装配方负责三态求值与 ask 交互（ConfirmPrompt 桥）；不配则全放行（测试/argv 简化路径）。
   */
  checkHookPermission?: (owner: string, event: HookEvent) => Promise<boolean>
}

const NO_OP_VERDICT: HookVerdict = { block: false, additionalContext: [], systemMessages: [] }

export class HookRunner {
  private readonly deps: HookRunnerDeps

  constructor(deps: HookRunnerDeps) {
    this.deps = deps
  }

  /**
   * 快速判断（无 hook 的事件零开销跳过 await）。只看事件不看 matcher——
   * 带 matcher 的 hook 是否命中由 dispatch 拿到 tool_name 后判定（此处过滤会漏跳过装饰层）。
   */
  hasHandlers(event: HookEvent): boolean {
    const user = this.deps.getUserHooks?.() ?? []
    if (user.some((s) => s.event === event)) return true
    return this.deps.extensions.specs().some((s) => s.event === event)
  }

  /** 合并双源 + event/matcher 过滤。 */
  specsFor(event: HookEvent, toolName?: string): HookSpec[] {
    const user = this.deps.getUserHooks?.() ?? []
    const ext = this.deps.extensions.specs()
    return [...user, ...ext].filter(
      (s) => s.event === event && matcherMatches(s.matcher, toolName),
    )
  }

  /**
   * 分发执行并聚合裁决。多 hook 顺序执行：
   * - block：任一 continue:false 即 block（取首个 reason）
   * - updatedInput：后者覆盖前者（MVP 不做链式改参——多 hook 同时改参属病态配置）
   * - additionalContext / systemMessage：收集全部
   * - async:true 的 hook：fire-and-forget，不参与裁决
   */
  async dispatch(event: HookEvent, input: HookInput, opts?: { signal?: AbortSignal }): Promise<HookVerdict> {
    const filled: HookInput =
      input.session_id === '' ? { ...input, session_id: this.deps.getSessionId?.() ?? '' } : input
    const specs = this.specsFor(event, filled.tool_name)
    if (specs.length === 0) return NO_OP_VERDICT

    const verdict: HookVerdict = { block: false, additionalContext: [], systemMessages: [] }
    let currentInput = filled.tool_input
    for (const spec of specs) {
      // M9-P5：扩展源 hook 首次执行前权限门（owner 由 registry 注入；用户源无 owner 不问）
      if (spec.owner !== undefined && this.deps.checkHookPermission !== undefined) {
        const allowed = await this.deps.checkHookPermission(spec.owner, event)
        if (!allowed) {
          this.deps.warn?.(`hook 被权限规则拒绝，跳过：${spec.owner} → ${event}`)
          continue
        }
      }
      if (spec.handler.kind === 'command' && spec.handler.async === true) {
        // fire-and-forget：异步通知类 hook（如"提交后发通知"），失败只告警
        void this.runOne(spec, { ...filled, tool_input: currentInput }, opts).catch(() => {})
        continue
      }
      const out = await this.runOne(spec, { ...filled, tool_input: currentInput }, opts)
      if (out === null) continue
      if (out.continue === false && !verdict.block) {
        verdict.block = true
        verdict.reason = out.reason ?? out.systemMessage ?? ''
      }
      if (out.updatedInput !== undefined) currentInput = out.updatedInput
      if (typeof out.additionalContext === 'string' && out.additionalContext !== '') {
        verdict.additionalContext.push(out.additionalContext)
      }
      if (typeof out.systemMessage === 'string' && out.systemMessage !== '') {
        verdict.systemMessages.push(out.systemMessage)
      }
    }
    if (currentInput !== filled.tool_input) verdict.updatedInput = currentInput
    return verdict
  }

  /** 单条执行 + fail-open 兜底（执行失败返回 null，只 warn）。 */
  private async runOne(spec: HookSpec, input: HookInput, opts?: { signal?: AbortSignal }): Promise<ReturnType<HookExecutor> | null> {
    try {
      return await this.deps.execute(spec, input, opts)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const label = spec.handler.kind === 'command' ? spec.handler.command : spec.handler.kind
      this.deps.warn?.(`hook 执行失败（放行）：${spec.event} → ${label}：${msg}`)
      return null
    }
  }
}
