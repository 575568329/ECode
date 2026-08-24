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
  /** M13-W3：项目路径（正斜杠规范形——SessionBrief.project） */
  cwd?: string
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
  /** createConversation 产物留档（ensureRestore 冷会话载入要用 deps.history.restoreFull） */
  private readonly convDeps = new Map<string, HostDeps>()
  /** restore 单飞（并发同 id 冷启动只载一次——deferred 模式：先登记再跑体，M12 实测坑⑤同款） */
  private readonly pendingRestore = new Map<string, Promise<HostSession>>()
  /** 默认会话（缺省 sessionId 命令的目标；首个 ensure 者转正，被收后不持久化——下次 ensure 重建） */
  private defaultId: string | null = null
  /** 会话空闲打点（sweepSessions 消费；prompt/restore 等 touch 点更新） */
  private readonly lastActive = new Map<string, number>()

  /** M13-W3：会话生命周期监听器集（mux 层接——session/created·removed 帧的源） */
  private readonly sessionListeners = new Set<(kind: 'created' | 'removed', info: { sessionId: string; brief?: import('../protocol/mux.js').SessionBrief }) => void>()

  constructor(private readonly deps: ProjectHostDeps) {
    this.skills = deps.skills ?? createSkillRegistry()
    this.extHooks = deps.extHooks ?? new ExtensionHooksRegistry()
    this.skillHooks = makeSkillHooksPort(this.extHooks)
  }

  /** M13-W3：订阅会话生命周期（返回退订；mux 连接用） */
  onSessionEvent(cb: (kind: 'created' | 'removed', info: { sessionId: string; brief?: import('../protocol/mux.js').SessionBrief }) => void): () => void {
    this.sessionListeners.add(cb)
    return () => this.sessionListeners.delete(cb)
  }

  private emitSession(kind: 'created' | 'removed', info: { sessionId: string; brief?: import('../protocol/mux.js').SessionBrief }): void {
    for (const cb of this.sessionListeners) cb(kind, info)
  }

  /** M13-W3：活会话快照（mux 订阅遍历用——[sessionId, HostSession] 数组） */
  conversationsSnapshot(): Array<[string, HostSession]> {
    return [...this.conversations.entries()]
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
   * 幂等建/取会话（同步——构造无异步环节）。prebuilt：cli 首会话传已组装 HostDeps
   * （与 Deps.history 同实例——TuiApp 直读路径等价）。
   */
  ensure(sessionId: string, prebuilt?: HostDeps): HostSession {
    const live = this.conversations.get(sessionId)
    if (live !== undefined) return live
    const convDeps = prebuilt ?? this.deps.createConversation(sessionId)
    const host = new HostSession(convDeps)
    if (this.deps.autoMountBridges !== false) host.mountBridges()
    this.conversations.set(sessionId, host)
    this.convDeps.set(sessionId, convDeps)
    this.lastActive.set(sessionId, Date.now())
    if (this.defaultId === null) this.defaultId = sessionId
    this.emitSession('created', { sessionId, brief: this.briefOf(sessionId) })
    return host
  }

  /** M13-W3：会话摘要（baseline/created 帧体——标题取首条 user 文本截断） */
  private get cwd(): string {
    return this.deps.cwd ?? ''
  }

  private briefOf(sessionId: string): import('../protocol/mux.js').SessionBrief {
    const host = this.conversations.get(sessionId)
    const firstUser = host?.transcript.find((l) => typeof l === 'object' && 'role' in l && l.role === 'user')
    const title =
      firstUser !== undefined && 'content' in firstUser && Array.isArray(firstUser.content)
        ? (firstUser.content.find((b) => b.type === 'text') as { text?: string } | undefined)?.text ?? ''
        : ''
    return { project: this.cwd, sessionId, running: host?.isBusy ?? false, title, updatedAt: this.lastActive.get(sessionId) ?? Date.now() }
  }

  /** M13-W3：全部活会话摘要（mux baseline 帧） */
  briefs(): import('../protocol/mux.js').SessionBrief[] {
    return [...this.conversations.keys()].map((id) => this.briefOf(id))
  }

  /**
   * M13-W2 restore=ensure：活会话复用；冷会话（history 文件在、宿主无实例）载入新建。
   * 并发同 id 幂等单飞（deferred：先登记 promise 再跑体——同步完成不留死条目）。
   */
  async ensureRestore(sessionId: string): Promise<HostSession> {
    const live = this.conversations.get(sessionId)
    if (live !== undefined) return live
    const inflight = this.pendingRestore.get(sessionId)
    if (inflight !== undefined) return inflight
    let settle!: (h: HostSession) => void
    const p = new Promise<HostSession>((res) => {
      settle = res
    })
    this.pendingRestore.set(sessionId, p)
    const host = this.ensure(sessionId)
    const lines = this.convDeps.get(sessionId)?.history.restoreFull(sessionId) ?? []
    host.restoreFrom(lines)
    this.pendingRestore.delete(sessionId)
    settle(host)
    return p
  }

  /** 活跃度打点（路由/命令命中时调——sweepSessions 依据） */
  touch(sessionId: string): void {
    this.lastActive.set(sessionId, Date.now())
  }

  /**
   * M13-W2 会话级 sweep（方案 §3.4：项目基座常驻不收，闲置会话回收）。
   * 三闸：有订阅者 / 有挂起审批 / 运行态（busy=loop 在跑或队列非空）——任一命中跳过；
   * 历史文件/checkpoint 不动（restore 即续）。返回回收数。
   */
  sweepSessions(idleMinutes: number): number {
    const cutoff = Date.now() - idleMinutes * 60_000
    let reclaimed = 0
    for (const [id, host] of [...this.conversations]) {
      if ((this.lastActive.get(id) ?? Date.now()) > cutoff) continue
      if (host.channel.subscriberCount > 0 || host.brokerPending > 0 || host.isBusy) continue
      this.disposeConversation(id)
      reclaimed++
    }
    return reclaimed
  }

  /** 会话回收（sweepSessions 的执行位；历史文件/checkpoint 不动） */
  disposeConversation(sessionId: string): boolean {
    const host = this.conversations.get(sessionId)
    if (host === undefined) return false
    host.dispose()
    this.conversations.delete(sessionId)
    this.convDeps.delete(sessionId)
    this.lastActive.delete(sessionId)
    if (this.defaultId === sessionId) this.defaultId = null
    this.emitSession('removed', { sessionId })
    return true
  }

  disposeAll(): void {
    for (const host of this.conversations.values()) host.dispose()
    this.conversations.clear()
    this.convDeps.clear()
    this.lastActive.clear()
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
