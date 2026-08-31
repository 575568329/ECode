/**
 * 依赖装配（M14-C3① 自 cli/index.ts 拆出——892 行四职责拆三件之一）。
 *
 * M13-W1 两级装配：makeProjectParts（项目级——provider/工具/hooks/checkpoint/quality/
 * skill/plugin，一项目一套随 ProjectHost 跨会话共享）+ makeConversationDeps（会话级——
 * history 绑 sessionId）+ makeDeps（前两者组装 + 首会话 + ProjectHost，TuiApp/serve
 * 消费 Deps 整袋）。
 *
 * 独立模块（非 cli/index 内函数）后可被测试 import——入口文件的 main() 副作用不再
 * 阻断装配层测试（M14-C3⑤ serve 补加载的加载效果断言依赖此拆分）。
 */
import { buildProviderReq, loadDotenvMap, type Config } from '../services/config.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { OpenaiProvider } from '../providers/openai.js'
import { LLMProviderRegistryImpl } from '../providers/registry.js'
import { ToolRegistryImpl } from '../tools/registry.js'
import { FileHistoryStore } from '../services/history.js'
import { CheckpointStore } from '../services/checkpoint.js'
import { QualityGate, detectQualityCommands, makeShellRunner } from '../services/quality.js'
import { makeSandbox, type SandboxMode } from '../services/sandbox.js'
import { resolveSearchProvider } from '../services/websearch.js'
import { setWebSearchProvider } from '../tools/builtin/web_search.js'
import { evalPermission, loadPermissionLayers, saveLocalPermission, askPermissionInteractive } from '../services/permissions.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import { makeTaskTool } from '../services/subagent.js'
import { makeSkillTool } from '../tools/builtin/skill.js'
import { SummarizeStrategy } from '../services/compaction/summarize.js'
import { skillRegistry, createSkillRegistry } from '../services/skill.js'
import { makeSkillHooksPort, globalExtensionHooks, type SkillHooksPort } from '../services/hooks/global.js'
import { ExtensionHooksRegistry } from '../services/hooks/registry.js'
import { ProjectHost } from '../host/project.js'
import { isValidSessionId, type HostDeps } from '../host/session.js'
import { setupMcp } from '../services/mcp/setup.js'
import type { McpManager } from '../services/mcp/manager.js'
import { loadInstructions } from '../services/instructions.js'
import { loadMemoryIndexes } from '../services/memory.js'
import { HookRunner } from '../services/hooks/runner.js'
import { parseUserHooks } from '../services/hooks/validate.js'
import { runCommandHook } from '../services/hooks/exec.js'
import { HookedToolRegistry } from '../tools/hooked.js'
import { setWebFetchLimits } from '../tools/builtin/web_fetch.js'
import { BUILTIN_TOOLS } from '../tools/builtin/index.js'
import { PluginLoader } from '../services/plugin/loader.js'
import { registerBuiltinCommands, commandRegistry, CommandRegistry } from '../commands/registry.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'

export interface Deps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  config: Config
  orchestrator: CompactionOrchestrator
  lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number }
  skillRegistry: ReturnType<typeof createSkillRegistry>
  /** M14-C3④：命令面实例（缺省模块单例——InputStream 直读同源；serve 每项目实例防 plugin 命令串台） */
  commands: import('../commands/registry.js').CommandRegistry
  mcpManager: McpManager | null
  mcpPendingApproval?: { file: string; approve: () => Promise<void> }
  mcpWarnings: string[]
  /** M8：指令/记忆截断提示（用户需知——自己写的 ECODE.md/MEMORY.md 没全生效） */
  instructionWarnings: string[]
  hookRunner: HookRunner | null
  pluginLoader: PluginLoader | null
  /** M9-P1：快照存储（onBeforeWrite 装配进 toolCtx） */
  checkpoint?: CheckpointStore | null
  /** M9-P3：编辑后 lint/test 回喂门（afterTools 装配进 runLoop opts） */
  quality?: QualityGate | null
  /** M13-W1：项目宿主（会话容器——TuiApp/argv/serve 经它取会话；测试 fake 缺省走内联构造兜底） */
  project?: import('../host/project.js').ProjectHost
  /** M13-W1：skill hooks 写端口（项目级 registry 绑定——TuiApp /clear 与手动触发经此，多项目不串台） */
  skillHooks?: import('../services/hooks/global.js').SkillHooksPort
}

/** M13-W1：项目级件（一项目一套——ProjectHost 持有，跨会话共享；opencode Instance 同构）。
 *  挂账沿用：setWebFetchLimits/setWebSearchProvider 仍进程级（同值覆写无害）；makeTaskTool 的
 *  onBeforeWrite 快照经 sessionRef.id 取当前会话（多会话并发时最后 ensure 者胜——W2 信封路由收口）。 */
export interface ProjectParts {
  providerReg: LLMProviderRegistryImpl
  hookedTools: HookedToolRegistry
  orchestrator: CompactionOrchestrator
  hookRunner: HookRunner
  checkpoint: CheckpointStore
  quality: QualityGate
  pluginLoader: PluginLoader
  skills: ReturnType<typeof createSkillRegistry>
  extHooks: ExtensionHooksRegistry
  mcpManager: McpManager | null
  mcpWarnings: string[]
  mcpPendingApproval?: { file: string; approve: () => Promise<void> }
  instructionWarnings: string[]
}

/** M13-W1 项目级装配（原 makeDeps 主体；会话级件 history 拆出到 makeConversationDeps） */
export function makeProjectParts(
  config: Config,
  logger: Logger,
  dir: string,
  registries: { skills: ReturnType<typeof createSkillRegistry>; extHooks: ExtensionHooksRegistry },
  sessionRef: { id: string },
): ProjectParts {
  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  providerReg.register(new OpenaiProvider())
  const toolReg = new ToolRegistryImpl()
  for (const t of BUILTIN_TOOLS) {
    // F-28：Skill 工具走 makeSkillTool 工厂（注入项目级 registry——serve freshRegistries
    // 每项目新实例，静态 skillTool 闭包读空单例）；BUILTIN_TOOLS 里的静态版跳过，
    // 装配期在下方注册注入版。防漂移测试仍从 BUILTIN_TOOLS 断言（工具名/描述同源）。
    if (t.name === 'Skill') continue
    toolReg.register(t) // 单一事实源（tools/builtin/index.ts）——防漂移测试同源断言
  }
  toolReg.register(makeSkillTool(registries.skills))
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())

  // models.dev 预热（fire-and-forget）：进程首次无缓存时 resolveContextWindow 联网拉取（10s timeout），
  // 不预热会恰好卡在用户第一轮提问的压缩判定前——启动期提前拉，失败静默（走内置表兜底）
  void resolveContextWindow(config.current.model, config.providers[config.current.name]?.contextWindow).catch(() => {})
  // M6 M-P9：MCP 接线（cache 命中注册零连接；工具经 adaptTool 注册；项目级未批准走二段）
  // F-18 尾巴（批2c）：${ENV_VAR} 占位符回退读项目 .env（dotenvMap 不提升进 process.env 后补链）
  const mcp = setupMcp(config, toolReg, {
    warn: (m) => logger.warn('mcp', 'setup', { message: m }),
  }, { envFallback: loadDotenvMap(dir) })
  // M7 H-P1/H-P3：hooks 双源分发器 + 工具装饰（loop 拿代理零感知；runner 经 getter 可替换——H4 v3.1）
  // M13-W1：扩展源用项目级实例（serve 多项目不串台；REPL/argv 传模块单例同源兼容）
  const { hooks: userHooks, warnings: hookWarnings } = parseUserHooks(config.hooks)
  for (const w of hookWarnings) logger.warn('hooks', 'user_config', { message: w })
  // M9-P5：扩展源 hook 权限门（Hook(owner) 三态；用户源无 owner 不问）。
  // once 允许后本会话同 owner:event 不再问（session 记忆）；remember 落 local 层 settings.local.json。
  const permSessionAllowed = new Set<string>()
  const hookRunner = new HookRunner({
    extensions: registries.extHooks,
    execute: runCommandHook,
    getUserHooks: () => userHooks,
    // M13-W1（三单例收敛③）：sessionRef 随 ensureConversation 更新——多会话下 hook 事件
    // session_id 空值兜底动态化（显式传 id 的 dispatch 路径本就不受影响）
    getSessionId: () => sessionRef.id,
    warn: (m) => logger.warn('hooks', 'exec', { message: m }),
    checkHookPermission: async (owner, event, sessionId) => {
      const key = `${owner}:${event}`
      if (permSessionAllowed.has(key)) return true
      const resource = `Hook(${owner})`
      const behavior = evalPermission(resource, loadPermissionLayers(dir))
      if (behavior === 'allow') return true
      if (behavior === 'deny') return false
      // 审阅 P1-4：发起会话真实 id 优先（asker 键随会话路由）；空串（argv/无端口）走项目级兜底
      const askKey = sessionId !== '' ? sessionId : sessionRef.id
      const answer = await askPermissionInteractive(askKey, owner, event)
      if (answer === null) {
        logger.warn('hooks', 'permission', { message: `无交互界面，ask 默认拒绝：${resource} → ${event}` })
        return false
      }
      if (answer.allow) {
        permSessionAllowed.add(key)
        if (answer.remember) saveLocalPermission(dir, 'allow', resource)
      }
      return answer.allow
    },
  })
  let hookRunnerRef: HookRunner | null = hookRunner
  const hookedTools = new HookedToolRegistry(toolReg, () => hookRunnerRef)
  // M8：指令/记忆截断检查（用户提示——注入内容对用户不可见，截断了必须让用户知道可行动）
  const maxInstructionBytes = config.maxInstructionsKB !== undefined ? config.maxInstructionsKB * 1024 : undefined
  const instructionWarnings: string[] = []
  for (const b of loadInstructions(maxInstructionBytes !== undefined ? { maxBytes: maxInstructionBytes } : {})) {
    if (b.truncated === true) instructionWarnings.push(`指令文件（${b.source}）超出上限被截断——可拆分文件或在 config 调大 maxInstructionsKB`)
  }
  for (const m of loadMemoryIndexes(maxInstructionBytes !== undefined ? { maxBytes: maxInstructionBytes } : {})) {
    if (m.truncated === true) instructionWarnings.push(`记忆索引（${m.level === 'user' ? '用户级' : '项目级'}）超出上限被截断`)
  }
  setWebFetchLimits({ maxContentKB: config.webFetchMaxKB })
  // M10-P1：三层装配（搜索 MCP 命中→null 不注册内置；默认 bing RSS；配置后 zhipu）
  setWebSearchProvider(resolveSearchProvider(config))
  const checkpoint = new CheckpointStore(dir, {
    warn: (m) => logger.warn('checkpoint', 'snapshot', { message: m }),
  })
  // M11-P5：task 工具（装配期工厂——deps 全 getter/引用；UI 桥由宿主挂，argv 无 UI confirm fail-closed）
  toolReg.register(makeTaskTool({
    getProviderReq: () => buildProviderReq(config),
    getProvider: () => providerReg.getByType(config.providers[config.current.name].type),
    logger,
    makeAfterTools: () => {
      // 子代理独立 QualityGate（P1-2 熔断计数不互扰）+ 剥离 autoCommit/后台通知（提交只归父轮末）
      const sub = new QualityGate({
        commands: detectQualityCommands(dir, { lintCommand: config.lintCommand, testCommand: config.testCommand }),
        run: makeShellRunner(dir),
        warn: (m) => logger.warn('quality', 'subagent', { message: m }),
      })
      return async (round) => {
        const fb = await sub.afterRound(round.tools)
        return fb !== undefined ? { feedback: fb } : undefined
      }
    },
    onBeforeWrite: async (paths, tool, toolUseId) => {
      // M13-W1：会话级 history 拆出后经 sessionRef 取当前会话 id（W1 单会话语义等价）
      await checkpoint?.snapshot(sessionRef.id, paths, { tool, messageId: toolUseId })
    },
    sandbox: makeSandbox(
      (config.sandbox?.defaultMode as SandboxMode) ?? 'default',
      dir,
      config.sandbox?.blockedCommands ?? [],
    ),
    cwd: dir,
    // 审阅 P1-3：传 hookedTools（HookedToolRegistry）——子代理工具调用过 PreToolUse/PostToolUse/
    // 权限门（get 返回 hook 包装版；SubRegistry 是过滤视图不剥装饰）
    registry: hookedTools,
    projectInstructions: loadInstructions()
      .filter((b) => b.source.startsWith('项目级'))
      .map((b) => b.content)
      .join('\n'),
    getModel: () => config.current.model,
  }))
  return {
    providerReg,
    hookedTools,
    orchestrator,
    hookRunner,
    checkpoint,
    quality: new QualityGate({
      commands: detectQualityCommands(dir, { lintCommand: config.lintCommand, testCommand: config.testCommand }),
      run: makeShellRunner(dir),
      warn: (m) => logger.warn('quality', 'gate', { message: m }),
    }),
    pluginLoader: new PluginLoader({ warn: (m) => logger.warn('plugin', 'load', { message: m }) }),
    skills: registries.skills,
    extHooks: registries.extHooks,
    mcpManager: mcp.manager,
    mcpWarnings: mcp.warnings,
    instructionWarnings,
    ...(mcp.pendingApproval !== undefined ? { mcpPendingApproval: mcp.pendingApproval } : {}),
  }
}

/** M13-W1 会话级件（一会话一套——history 绑 sessionId；HostSession 的 HostDeps 组装点） */
export function makeConversationDeps(
  parts: ProjectParts,
  logger: Logger,
  config: Config,
  sessionId: string,
  dir: string,
  sessionRef: { id: string },
  skillHooks: SkillHooksPort,
  projectRef: { current?: ProjectHost },
  approvalPolicy?: 'ask' | 'auto-approve',
  commands?: CommandRegistry,
): { host: HostDeps; history: FileHistoryStore } {
  sessionRef.id = sessionId // 三单例收敛③：hook 事件 session_id 兜底动态化
  const history = new FileHistoryStore({ sessionId, model: config.current.model, cwd: dir }) // M13-W4：meta 落盘会话归属
  const host: HostDeps = {
    providerRegistry: parts.providerReg,
    tools: parts.hookedTools,
    logger,
    history,
    getConfig: () => config,
    orchestrator: parts.orchestrator,
    skillListForPrompt: () => parts.skills.listForPrompt(),
    hookRunner: parts.hookRunner,
    checkpoint: parts.checkpoint,
    quality: parts.quality,
    cwd: dir,
    skillHooks,
    // M13-W2：restore=ensure 项目端口（session/restore 命令经宿主 dispatch 落 ProjectHost；
    // projectRef 晚绑定——会话 deps 先于 ProjectHost 构造，makeDeps 尾部回填）
    ensureConversation: async (sid) => {
      const proj = projectRef.current
      if (proj === undefined) return { ok: false, error: 'ProjectHost 未装配', code: 'NOT_IMPLEMENTED' }
      // 会话 id 合法性守卫（G3 冒烟实测：垃圾 id 会静默起空会话）——白名单同宿主侧（审阅 P0-1）
      if (!isValidSessionId(sid)) return { ok: false, error: `会话 id 非法：${sid}`, code: 'BAD_SESSION_ID' }
      await proj.ensureRestore(sid)
      return { ok: true, sessionId: sid }
    },
    // M13-W4：session/list 冷热合并（活会话 running 态注入 meta 列表）
    conversationStates: () => projectRef.current?.runningMap() ?? new Map(),
    // T1 面板数据窄口（View 契约冻结 protocol/types——从项目级真件映射；宿主不 import 注册表类型）
    panelData: {
      skill: () => ({
        skills: parts.skills.listForCompletion().map((s) => ({
          name: s.name,
          description: s.description,
          source: s.source,
          userInvocable: s.userInvocable,
          disableModelInvocation: s.disableModelInvocation,
          ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
        })),
        shadowedCount: parts.skills.shadowedEntries.length,
      }),
      mcp: () => {
        const snaps = parts.mcpManager?.status() ?? []
        return {
          servers: snaps.map((s) => ({
            name: s.name,
            status: s.status,
            source: s.source,
            type: s.type,
            toolCount: s.toolCount,
            ...(s.error !== undefined ? { error: s.error } : {}),
            ...(s.failedAgoSec !== undefined ? { failedAgoSec: s.failedAgoSec } : {}),
          })),
          tools: Object.fromEntries(
            snaps.map((s) => [
              s.name,
              (parts.mcpManager?.toolsOf(s.name) ?? []).map((t) => ({ name: t.name, description: t.description })),
            ]),
          ),
        }
      },
      ...(parts.mcpManager != null
        ? {
            mcpAction: async (action: 'reconnect' | 'close', server: string) => {
              const mgr = parts.mcpManager
              if (mgr == null) return { ok: false, error: 'MCP 未装配' }
              if (action === 'close') {
                await mgr.close(server)
                return { ok: true, output: `已关闭：${server}` }
              }
              const r = await mgr.reconnect(server)
              if (r.failed.length > 0) return { ok: false, error: r.failed.map((f) => `${f.name}: ${f.error}`).join('；') }
              return { ok: true, output: r.ok.length > 0 ? `已重连：${r.ok.join('、')}` : `无变更：${server}` }
            },
          }
        : {}),
      ...(parts.mcpPendingApproval != null
        ? {
            approveMcp: async (file: string, approved: boolean) => {
              const pa = parts.mcpPendingApproval
              if (pa != null && approved && pa.file === file) await pa.approve()
            },
          }
        : {}),
    },
    // T1⑪：装配期告警（mcp/instruction）经宿主构造转 notice 帧
    startupWarnings: [...parts.mcpWarnings, ...parts.instructionWarnings],
    // F-23：命令面注入（serve/web 端 / 命令分流——/help 等不再落入 LLM）
    ...(commands !== undefined ? { commands } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
  }
  return { host, history }
}

/** M13-W1：makeDeps = 项目级件 + 首会话 + ProjectHost（签名不变——TuiApp/serve 消费 Deps 整袋）。
 *  opts.freshRegistries：serve 每项目新建 skills/extHooks 实例（多项目隔离）；
 *  REPL/argv 缺省复用模块单例（TUI 组件模块直读同源兼容）。
 *  opts.approvalPolicy：argv --yes 经此进会话 broker（原 runOnce 构造参数前移到装配点）。 */
export function makeDeps(
  config: Config,
  logger: Logger,
  sessionId: string,
  dir: string = process.cwd(),
  opts: { freshRegistries?: boolean; approvalPolicy?: 'ask' | 'auto-approve' } = {},
): Deps {
  const skills = opts.freshRegistries === true ? createSkillRegistry() : skillRegistry
  const extHooks = opts.freshRegistries === true ? new ExtensionHooksRegistry() : globalExtensionHooks
  // M14-C3④：命令面随注册表族装配（fresh=每项目实例，plugin 命令不跨项目串台；
  // 缺省=模块单例，InputStream 直读同源）。builtin 注册挪到此处（幂等）——原 main 显式调退役
  const commands = opts.freshRegistries === true ? new CommandRegistry() : commandRegistry
  registerBuiltinCommands(commands)
  const skillHooks = makeSkillHooksPort(extHooks)
  const sessionRef = { id: sessionId }
  const parts = makeProjectParts(config, logger, dir, { skills, extHooks }, sessionRef)
  const projectRef: { current?: ProjectHost } = {}
  const conv0 = makeConversationDeps(parts, logger, config, sessionId, dir, sessionRef, skillHooks, projectRef, opts.approvalPolicy, commands)
  const project = new ProjectHost({
    createConversation: (sid) =>
      makeConversationDeps(parts, logger, config, sid, dir, sessionRef, skillHooks, projectRef, opts.approvalPolicy, commands).host,
    skills,
    extHooks,
  })
  projectRef.current = project
  project.ensure(sessionId, conv0.host)
  return {
    providerRegistry: parts.providerReg,
    tools: parts.hookedTools,
    logger,
    history: conv0.history,
    checkpoint: parts.checkpoint,
    quality: parts.quality,
    config,
    orchestrator: parts.orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry: skills,
    commands,
    skillHooks,
    project,
    mcpManager: parts.mcpManager,
    mcpWarnings: parts.mcpWarnings,
    instructionWarnings: parts.instructionWarnings,
    hookRunner: parts.hookRunner,
    pluginLoader: parts.pluginLoader,
    ...(parts.mcpPendingApproval !== undefined ? { mcpPendingApproval: parts.mcpPendingApproval } : {}),
  }
}

