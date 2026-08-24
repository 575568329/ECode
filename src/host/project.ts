/**
 * M13-W1 项目宿主：ProjectHost（项目级容器）+ HostSession（会话层，命名保留兼容）。
 *
 * 分层（方案 §3.1，opencode Instance/Session 同构）：
 * - ProjectHost：项目级共享件（skills/extHooks 注册表实例、会话 Map）——常驻不回收（W2 接
 *   ProjectRegistry：path→ProjectHost，锁语义不变）；同项目多会话并行的容器。
 * - HostSession：会话级私有（messages/channel/broker/插话/usage/sandbox/rewind）——本类不改其职责。
 *
 * W1 等价形态：TuiApp/argv = 单 ProjectHost + 单会话（与 M12 行为一致，旧用例零改动）；
 * serve = 每项目一个 ProjectHost（cli createSession 内部接线，ProjectRegistry 本批不动）。
 *
 * 三全局单例收敛落点（审阅 P0 串台三连）：
 * ① skillRegistry/globalExtensionHooks → 本类持实例（REPL/argv 传模块单例保持 TUI 模块直读兼容；
 *    serve 每项目新建——多项目 /clear 只清自家 registry）；
 * ② mountBridges → ensure 时逐会话挂（闭包捕获该会话；dispose 归属守卫见 session.ts）；
 * ③ HookRunner.getSessionId → cli 侧 sessionRef 随 ensure 更新（dispatch 带 session_id 的路径本就
 *    显式传值，此为空值兜底的动态化）。
 */

import { ExtensionHooksRegistry } from '../services/hooks/registry.js'
import { makeSkillHooksPort, type SkillHooksPort } from '../services/hooks/global.js'
import { createSkillRegistry, type SkillRegistry } from '../services/skill.js'
import { HostSession, type HostDeps } from './session.js'

export interface ProjectHostDeps {
  /** 会话工厂（cli 传 makeConversationDeps 装配——projectId 由调用方生成策略持有） */
  createConversation: (sessionId: string) => HostDeps
  /** 项目级 skill 注册表（REPL/argv 传模块单例；serve 每项目新建；缺省新建） */
  skills?: SkillRegistry
  /** 项目级扩展 hooks 注册表（同上） */
  extHooks?: ExtensionHooksRegistry
  /** ensure 时自动挂桥（默认 true；宿主测试传 false 防模块槽串台） */
  autoMountBridges?: boolean
}

export class ProjectHost {
  readonly skills: SkillRegistry
  readonly extHooks: ExtensionHooksRegistry
  /** skill hooks 写端口（绑本项目 registry——TuiApp/工具经此写，多项目不串台） */
  readonly skillHooks: SkillHooksPort
  private readonly conversations = new Map<string, HostSession>()
  /** 默认会话（缺省 sessionId 命令的目标；首个 ensure 者转正，被收后不持久化——下次 ensure 重建） */
  private defaultId: string | null = null

  constructor(private readonly deps: ProjectHostDeps) {
    this.skills = deps.skills ?? createSkillRegistry()
    this.extHooks = deps.extHooks ?? new ExtensionHooksRegistry()
    this.skillHooks = makeSkillHooksPort(this.extHooks)
  }

  /** 当前（默认）会话 id——HookRunner.getSessionId 空值兜底与缺省路由共用 */
  get currentSessionId(): string {
    return this.defaultId ?? ''
  }

  get size(): number {
    return this.conversations.size
  }

  conversation(sessionId: string): HostSession | undefined {
    return this.conversations.get(sessionId)
  }

  /** 默认会话（不存在则用 freshId 新建——cli 侧生成策略传入） */
  ensureDefault(freshId: string): HostSession {
    return this.ensure(this.defaultId ?? freshId)
  }

  /**
   * 幂等建/取会话（同步——构造无异步环节；W2 restore=ensure 的 deferred 单飞在彼批加，
   * 冷会话载入 restoreFrom 属命令路由层职责）。prebuilt：cli 首会话传已组装 HostDeps
   * （与 Deps.history 同实例——TuiApp 直读路径等价）。
   */
  ensure(sessionId: string, prebuilt?: HostDeps): HostSession {
    const live = this.conversations.get(sessionId)
    if (live !== undefined) return live
    const host = new HostSession(prebuilt ?? this.deps.createConversation(sessionId))
    if (this.deps.autoMountBridges !== false) host.mountBridges()
    this.conversations.set(sessionId, host)
    if (this.defaultId === null) this.defaultId = sessionId
    return host
  }

  /** 会话回收（W2 会话级 sweep 的执行位；历史文件/checkpoint 不动） */
  disposeConversation(sessionId: string): boolean {
    const host = this.conversations.get(sessionId)
    if (host === undefined) return false
    host.dispose()
    this.conversations.delete(sessionId)
    if (this.defaultId === sessionId) this.defaultId = null
    return true
  }

  disposeAll(): void {
    for (const host of this.conversations.values()) host.dispose()
    this.conversations.clear()
    this.defaultId = null
  }

  /** 活跃度聚合（sweepIdle 兼容位：任一会话有订阅者/挂起审批即视为项目活跃——Q12） */
  get subscriberCount(): number {
    let n = 0
    for (const h of this.conversations.values()) n += h.channel.subscriberCount
    return n
  }

  get brokerPending(): number {
    let n = 0
    for (const h of this.conversations.values()) n += h.brokerPending
    return n
  }
}
