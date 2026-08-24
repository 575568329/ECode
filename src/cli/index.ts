#!/usr/bin/env node
/**
 * ECode CLI 入口（M2）。
 *
 * 两种模式：
 *   - 单次：`ecode "你的问题"` 或 `npm run dev -- "问题"` → M1 stdout 输出（脚本式，稳定）
 *   - REPL：`ecode` 或 `npm run dev` → Ink TUI（M2，替换 readline）
 *
 * argv 单次模式保留 M1 的 stdout 输出（脚本/管道友好，退出不清屏）；
 * REPL 是 M2 重点，用 Ink 全屏 TUI。
 *
 * ANSI 颜色（cli-highlight 代码高亮）靠 dev/start script 的 cross-env FORCE_COLOR=1
 * 在 Node 启动前注入（ESM import 是 hoisted，写在代码里会晚于 chalk 锁 level）。
 */

import { loadConfig, buildProviderReq, emptyShellConfig, type Config } from '../services/config.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { OpenaiProvider } from '../providers/openai.js'
import { LLMProviderRegistryImpl } from '../providers/registry.js'
import { ToolRegistryImpl } from '../tools/registry.js'
import { JsonlLogger } from '../services/logger.js'
import { LogStore } from '../services/logstore.js'
import { FileHistoryStore } from '../services/history.js'
import { CheckpointStore } from '../services/checkpoint.js'
import { QualityGate, detectQualityCommands, makeShellRunner } from '../services/quality.js'
import { makeSandbox } from '../services/sandbox.js'
import { resolveSearchProvider } from '../services/websearch.js'
import { setWebSearchProvider } from '../tools/builtin/web_search.js'
import { taskRegistry } from '../services/tasks.js'
import { evalPermission, loadPermissionLayers, saveLocalPermission, askPermissionInteractive } from '../services/permissions.js'
import { join } from 'node:path'
import { writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { render } from 'ink'
import React from 'react'
import { TuiApp } from '../tui/TuiApp.js'
import { registerBuiltinCommands, commandRegistry } from '../commands/registry.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import { makeTaskTool } from '../services/subagent.js'
import { SummarizeStrategy } from '../services/compaction/summarize.js'
import { skillRegistry, createSkillRegistry } from '../services/skill.js'
import { makeSkillHooksPort, type SkillHooksPort } from '../services/hooks/global.js'
import { ExtensionHooksRegistry } from '../services/hooks/registry.js'
import { ProjectHost } from '../host/project.js'
import type { HostDeps } from '../host/session.js'
import { setupMcp } from '../services/mcp/setup.js'
import type { McpManager } from '../services/mcp/manager.js'
import { makeGracefulShutdown } from '../services/gracefulShutdown.js'
import { loadInstructions } from '../services/instructions.js'
import { loadMemoryIndexes } from '../services/memory.js'
import { globalExtensionHooks } from '../services/hooks/global.js'
import { HookRunner } from '../services/hooks/runner.js'
import { parseUserHooks } from '../services/hooks/validate.js'
import { runCommandHook } from '../services/hooks/exec.js'
import { HookedToolRegistry } from '../tools/hooked.js'
import { setWebFetchLimits } from '../tools/builtin/web_fetch.js'
import { BUILTIN_TOOLS } from '../tools/builtin/index.js'
import { PluginLoader } from '../services/plugin/loader.js'
import { HostSession } from '../host/session.js'
import { serveMulti } from '../server/multi.js'
import { ProjectRegistry } from '../server/projects.js'

interface Deps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  config: Config
  orchestrator: CompactionOrchestrator
  lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number }
  skillRegistry: ReturnType<typeof createSkillRegistry>
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
interface ProjectParts {
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
function makeProjectParts(
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
  for (const t of BUILTIN_TOOLS) toolReg.register(t) // 单一事实源（tools/builtin/index.ts）——防漂移测试同源断言
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())

  // models.dev 预热（fire-and-forget）：进程首次无缓存时 resolveContextWindow 联网拉取（10s timeout），
  // 不预热会恰好卡在用户第一轮提问的压缩判定前——启动期提前拉，失败静默（走内置表兜底）
  void resolveContextWindow(config.current.model, config.providers[config.current.name]?.contextWindow).catch(() => {})
  // M6 M-P9：MCP 接线（cache 命中注册零连接；工具经 adaptTool 注册；项目级未批准走二段）
  const mcp = setupMcp(config, toolReg, {
    warn: (m) => logger.warn('mcp', 'setup', { message: m }),
  })
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
    checkHookPermission: async (owner, event) => {
      const key = `${owner}:${event}`
      if (permSessionAllowed.has(key)) return true
      const resource = `Hook(${owner})`
      const behavior = evalPermission(resource, loadPermissionLayers(dir))
      if (behavior === 'allow') return true
      if (behavior === 'deny') return false
      const answer = await askPermissionInteractive(owner, event)
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
      (config.sandbox?.defaultMode as 'default' | 'read-only' | 'workspace-write' | 'full-access') ?? 'default',
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
function makeConversationDeps(
  parts: ProjectParts,
  logger: Logger,
  config: Config,
  sessionId: string,
  dir: string,
  sessionRef: { id: string },
  skillHooks: SkillHooksPort,
  projectRef: { current?: ProjectHost },
  approvalPolicy?: 'ask' | 'auto-approve',
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
      await proj.ensureRestore(sid)
      return { ok: true, sessionId: sid }
    },
    // M13-W4：session/list 冷热合并（活会话 running 态注入 meta 列表）
    conversationStates: () => projectRef.current?.runningMap() ?? new Map(),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
  }
  return { host, history }
}

/** M13-W1：makeDeps = 项目级件 + 首会话 + ProjectHost（签名不变——TuiApp/serve 消费 Deps 整袋）。
 *  opts.freshRegistries：serve 每项目新建 skills/extHooks 实例（多项目隔离）；
 *  REPL/argv 缺省复用模块单例（TUI 组件模块直读同源兼容）。
 *  opts.approvalPolicy：argv --yes 经此进会话 broker（原 runOnce 构造参数前移到装配点）。 */
function makeDeps(
  config: Config,
  logger: Logger,
  sessionId: string,
  dir: string = process.cwd(),
  opts: { freshRegistries?: boolean; approvalPolicy?: 'ask' | 'auto-approve' } = {},
): Deps {
  const skills = opts.freshRegistries === true ? createSkillRegistry() : skillRegistry
  const extHooks = opts.freshRegistries === true ? new ExtensionHooksRegistry() : globalExtensionHooks
  const skillHooks = makeSkillHooksPort(extHooks)
  const sessionRef = { id: sessionId }
  const parts = makeProjectParts(config, logger, dir, { skills, extHooks }, sessionRef)
  const projectRef: { current?: ProjectHost } = {}
  const conv0 = makeConversationDeps(parts, logger, config, sessionId, dir, sessionRef, skillHooks, projectRef, opts.approvalPolicy)
  const project = new ProjectHost({
    createConversation: (sid) =>
      makeConversationDeps(parts, logger, config, sid, dir, sessionRef, skillHooks, projectRef, opts.approvalPolicy).host,
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

/** argv 单次模式：M1 stdout 输出（流式打印 + 工具摘要）。 */
async function runOnce(input: string, deps: Deps, approvalPolicy: 'ask' | 'auto-approve' = 'ask'): Promise<void> {
  // M12-B1：argv 切换为宿主消费方（同进程 InMemoryChannel + stdout 适配器）——
  // 与 TUI 走同一套装配/事件翻译（原内联装配退役）；行为增强：Stop hook/插话队列/轮末兜底随宿主获得
  // M13-W1：宿主取自 ProjectHost（makeDeps 已装配含 approvalPolicy——opts 前移）；无 project 的
  // 旧测试路径走内联构造兜底（行为与 M12 等价）
  const host =
    deps.project !== undefined
      ? deps.project.ensureDefault(deps.history.currentSessionId())
      : new HostSession({
          providerRegistry: deps.providerRegistry,
          tools: deps.tools,
          logger: deps.logger,
          history: deps.history,
          getConfig: () => deps.config,
          orchestrator: deps.orchestrator,
          skillListForPrompt: () => deps.skillRegistry.listForPrompt(),
          ...(deps.hookRunner != null ? { hookRunner: deps.hookRunner } : {}),
          ...(deps.checkpoint != null ? { checkpoint: deps.checkpoint } : {}),
          ...(deps.quality != null ? { quality: deps.quality } : {}),
          approvalPolicy,
          cwd: process.cwd(),
        })
  // B3：三桥宿主侧挂载（argv 无订阅者 → ask_user/权限/子代理副作用全 fail-closed——D1 语义；幂等）
  host.mountBridges()
  host.subscribe((ev) => {
    switch (ev.type) {
      case 'delta':
        process.stdout.write(ev.text)
        break
      case 'item/started':
        process.stdout.write(`\n⏺ ${ev.name}\n`)
        break
      case 'item/completed':
        process.stdout.write(`  ${ev.name} ${ev.isError ? '✗' : '✓'} ${ev.summary}\n`)
        break
      case 'usage':
        deps.lastUsage.input = ev.input
        deps.lastUsage.output = ev.output
        deps.lastUsage.cacheRead = ev.cacheRead ?? 0
        deps.lastUsage.cacheCreation = ev.cacheCreation ?? 0
        process.stdout.write(`\n[tokens: in ${ev.input} / out ${ev.output}]\n`)
        break
      case 'warn':
        process.stdout.write(`\n⚠ ${ev.text}\n`)
        break
      case 'notice':
        process.stdout.write(`\n${ev.level === 'error' ? '✗' : ev.level === 'warn' ? '⚠' : 'ℹ'} ${ev.text}\n`)
        break
      case 'systemMsg':
        process.stdout.write(`\n${ev.text}\n`)
        break
      case 'compacted':
        process.stdout.write('\n[已压缩对话]\n')
        break
      case 'error':
        process.stderr.write(`\n✗ ${ev.message}\n`)
        break
      default:
        break
    }
  })
  const r = await host.send({ op: 'prompt', text: input, mode: 'StartOrSteer' })
  if (!r.ok) {
    throw new Error(r.error)
  }
  await host.whenIdle()
  process.stdout.write('\n')
  host.dispose() // 审阅 P1-7：会话级任务表/审批收敛（缺它 argv 后台任务孤儿化）
}

/**
 * M12-B7：`ecode serve` 常驻模式——单会话宿主上 HTTP（多项目 ProjectRegistry 在 B8）。
 * ready 单行 JSON 契约（orca 式）：stdout 只给端口与注册文件路径——**token 不打 stdout**（防本机进程读屏）。
 */
/** M12：`ecode serve stop`——读注册文件 → 验存活 → SIGTERM（调研结论：常驻+手动停，三家同款） */
async function serveStop(): Promise<void> {
  const regPath = join(os.homedir(), '.ecode', 'server.json')
  try {
    const reg = JSON.parse(readFileSync(regPath, 'utf8')) as { pid: number; port: number }
    process.kill(reg.pid, 0) // 探活：已死则 ESRCH 走 catch
    process.kill(reg.pid, 'SIGTERM')
    process.stdout.write(`已停止 serve（pid ${reg.pid}）
`)
  } catch (e) {
    process.stdout.write(`无需停止：${(e as { code?: string }).code === 'ESRCH' ? '进程已不在' : '注册文件不存在或损坏'}
`)
  }
  try {
    rmSync(regPath, { force: true })
  } catch {
    // 幂等
  }
}

async function serveMode(): Promise<void> {
  // 启动接管（调研结论 2）：旧 daemon 活着 → SIGTERM 让位（版本升级/重复启动即换新）
  try {
    const regPath = join(os.homedir(), '.ecode', 'server.json')
    const old = JSON.parse(readFileSync(regPath, 'utf8')) as { pid: number }
    process.kill(old.pid, 0)
    process.kill(old.pid, 'SIGTERM')
    await new Promise((r) => setTimeout(r, 800)) // 等旧进程清锁退出
  } catch {
    // 无旧实例/已死——直接起
  }
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-')
  const logger = new JsonlLogger(new LogStore(join(process.cwd(), '.ecode', 'logs', `serve-${sessionId}.jsonl`), sessionId))
  const config = loadConfig()
  const registry = new ProjectRegistry({
    createSession: (cwd) => {
      // M13-W1：每项目独立 skills/extHooks 实例（多项目 /clear 不串台）+ 会话取自 ProjectHost；
      // ProjectRegistry 本批不动（W2 升维 path→ProjectHost）——对 registry 而言仍是"每项目一个 HostSession"
      const sid = new Date().toISOString().replace(/[:.]/g, '-')
      const deps = makeDeps(config, logger, sid, cwd, { freshRegistries: true })
      if (deps.project === undefined) throw new Error('ProjectHost missing in makeDeps')
      deps.project.ensure(sid) // 首会话（W2：registry 存 ProjectHost，会话 Map 内含；信封三态按需增会话）
      return deps.project
    },
  })
  registry.register(process.cwd())
  // 多项目 serve（B8.2）：默认项目=启动 cwd；/api/projects 列表 + /api/p/<path>/ 项目路由
  // M13-W3（绑定语义显式化 + 启动体验）：ECODE_SERVE_HOST 三态（loopback 默认/局域网 IP/LAN 全网卡）；
  // 非 loopback 强制 ECODE_SERVER_PASSWORD（serveMulti 同款校验双保险）；启动打印完整访问 URL
  const serveHost = process.env.ECODE_SERVE_HOST ?? '127.0.0.1'
  const servePassword = process.env.ECODE_SERVER_PASSWORD ?? ''
  const isLoopbackServe = serveHost === '127.0.0.1' || serveHost === '::1' || serveHost === 'localhost'
  if (!isLoopbackServe && servePassword === '') {
    process.stderr.write('✗ 非 loopback 绑定（ECODE_SERVE_HOST=' + serveHost + '）必须设置 ECODE_SERVER_PASSWORD——拒绝启动（防裸奔局域网）\n')
    process.exit(1)
  }
  const srv = await serveMulti({ registry, defaultCwd: process.cwd() }, { port: Number(process.env.ECODE_SERVE_PORT ?? 0), host: serveHost, password: servePassword })
  // 注册文件（B8 daemon 生命周期的锚点）：0600，含 token——客户端从这里读
  const regPath = join(os.homedir(), '.ecode', 'server.json')
  writeFileSync(regPath, JSON.stringify({ id: sessionId, port: srv.port, token: srv.token, pid: process.pid }, null, 2), { mode: 0o600 })
  chmodSync(regPath, 0o600)
  console.log(JSON.stringify({ type: 'ready', schemaVersion: 1, bound: `${serveHost}:${srv.port}`, register: regPath }))
  // 局域网形态打印手机可直接点击的访问 URL（半行代码消除"我该在手机输什么"的摩擦——审阅 P1）
  if (!isLoopbackServe) {
    const lanIp = Object.values(os.networkInterfaces())
      .flat()
      .find((n): n is os.NetworkInterfaceInfo => n !== undefined && n.family === 'IPv4' && n.internal === false)?.address
    if (lanIp !== undefined) process.stdout.write(`Mobile: http://${lanIp}:${srv.port}\n`)
    process.stdout.write('提示：DHCP 可能变动局域网 IP——建议为公司电脑配置静态 IP（中继形态 M14 后此问题消失）\n')
  }
  // 空闲回收（30 分钟 sweep；审批/UI 挂起不回收）
  // M13-W2：会话级回收（项目基座常驻——Q5 两家实证）；sessionIdleMinutes 默认 120，0=不收
  const sessionIdleMinutes = config.sessionIdleMinutes ?? 120
  const sweep = sessionIdleMinutes > 0 ? setInterval(() => void registry.sweepSessions(sessionIdleMinutes), 60_000) : null
  // 防脑裂（opencode 同款）：10s 校验注册 id 仍是自己——被更新版接管即让位自杀
  const myId = sessionId
  const watchdog = setInterval(() => {
    try {
      const cur = JSON.parse(readFileSync(join(os.homedir(), '.ecode', 'server.json'), 'utf8')) as { id: string }
      if (cur.id !== myId) {
        clearInterval(watchdog)
        if (sweep !== null) clearInterval(sweep)
        registry.disposeAll()
        process.exit(0)
      }
    } catch {
      // 注册文件被删（stop 已发 SIGTERM——此路径兜底）
    }
  }, 10_000)
  void watchdog
  // 审阅 P1-4：serve 分流先于 main 的 handler 注册——此处自管生命周期：
  // 一次信号 = 全量清理后退出（server.close 断流 → registry.disposeAll（锁释放/审批收敛）→ exit）
  const shutdown = (code: number): void => {
    if (sweep !== null) clearInterval(sweep)
    void (async () => {
      await srv.close()
      registry.disposeAll()
      process.exit(code)
    })()
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.once(sig, () => shutdown(0))
  }
  process.on('uncaughtException', (e) => {
    process.stderr.write(`serve 崩溃：${e instanceof Error ? e.message : String(e)}
`)
    shutdown(1)
  })
  await new Promise<never>(() => {}) // 常驻（无客户端不退——生命周期由上方 handler 管）
}

async function main(): Promise<void> {
  // M12：`ecode serve` 分流（常驻宿主 HTTP——不初始化 Ink）
  if (process.argv[2] === 'serve') {
    if (process.argv[3] === 'stop') {
      await serveStop()
      return
    }
    await serveMode()
    return
  }
  // P1-16：logger + process handlers 提前到 loadConfig 前（配置失败也要记日志 + 全局兜底尽早挂）
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(process.cwd(), '.ecode', 'logs', `${sessionId}.jsonl`)
  const logStore = new LogStore(logPath, sessionId)
  const logger = new JsonlLogger(logStore)
  // M6：MCP 子进程清理（best-effort——exit 内不能 await；SDK close 发 SIGTERM）
  let mcpManagerRef: McpManager | null = null
  let sessionEndHook: HookRunner | null = null
  let inkApp: { unmount(): void } | undefined
  // 优雅关闭（M7 调研后采用：信号 handler / 双击退出 / argv 收尾共用——先同步恢复终端，
  // 再预算内 await SessionEnd hooks 与 MCP stop，failsafe 定时器兜底强退）
  const gracefulShutdown = makeGracefulShutdown({
    restoreTerminal: () => {
      try {
        inkApp?.unmount()
      } catch {
        // 已卸载（TUI 关闭路径竞态）——恢复终端幂等
      }
    },
    runSessionEndHooks: () =>
      sessionEndHook?.dispatch('SessionEnd', { event: 'SessionEnd', session_id: '' }) ?? Promise.resolve(),
    stopMcp: () => mcpManagerRef?.stop() ?? Promise.resolve(),
    stopTasks: () => {
      // dispose：杀树 + 清理本会话 task-*.log（P2：输出含命令原文不脱敏，不留残骸）
      taskRegistry.dispose()
      return Promise.resolve()
    },
  })
  // exit handler = 兜底层（graceful 路径已完成异步清理；此处覆盖 uncaught/restart 等
  // 未走 graceful 的退出：stopNow 同步杀 + 日志 flush。注册序 = 执行序，先杀再 flush）
  process.on('exit', () => {
    mcpManagerRef?.stopNow()
  })
  process.on('exit', () => {
    logger.info('system', 'shutdown', { exitCode: process.exitCode })
    logStore.close()
  })
  // 信号 → 优雅关闭（TUI 的 Ctrl+C 被 Ink 捕获不产生 SIGINT，走 useInterrupt 的 onExit；
  // 此处覆盖 argv 模式与渲染前的 Ctrl+C、外部 kill、Windows 的 taskkill/SIGBREAK）
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.once(sig, () => gracefulShutdown(0))
  }
  // P1-8：异常路径同杀子进程（stopNow 同步 SIGKILL——异步 stop 在这里跑不完）再 flush 日志
  process.on('uncaughtException', (e) => {
    logger.error('system', 'uncaught', { message: e.message, stack: e.stack })
    mcpManagerRef?.stopNow()
    logStore.close()
    process.exit(1)
  })
  process.on('unhandledRejection', (r) => {
    const msg = r instanceof Error ? r.message : String(r)
    const stack = r instanceof Error ? r.stack : undefined
    logger.error('system', 'unhandled_rejection', { message: msg, stack })
    mcpManagerRef?.stopNow()
    logStore.close()
    process.exit(1)
  })

  // D10：配置有效性判断。有效 → 正常跑；无效 → argv 报错退出 / REPL+banner
  let config: Config
  let banner: string | undefined
  try {
    config = loadConfig()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('system', 'config_load_failed', { message: msg })
    if (process.argv.slice(2).join(' ').trim()) throw e // argv 非交互：报错退出（exit handler 同步 flush 日志）
    config = emptyShellConfig() // 空壳 P0-4：TuiApp 仍能渲染（banner + /setup 可用）
    banner = msg
  }
  registerBuiltinCommands()

  logger.info('system', 'startup', {
    model: config.current.model,
    cwd: process.cwd(),
    logPath,
    node: process.version,
    platform: process.platform,
    providerType: config.providers[config.current.name]?.type,
  })

  // M13-W1：--yes 前移（approvalPolicy 经 makeDeps opts 进会话 broker——原 runOnce 构造参数前移到装配点）
  const autoYes = process.argv.includes('--yes')
  const deps = makeDeps(config, logger, sessionId, process.cwd(), { approvalPolicy: autoYes ? 'auto-approve' : 'ask' })
  // M10-P3 终审 P1-6：后台任务完成钩子——走近修改集快照兜底（bash 同款语义；无 git 时 warn 跳过）
  taskRegistry.onComplete = (t) => {
    void deps.checkpoint
      ?.snapshot(deps.history.currentSessionId(), [], { tool: `bash-bg:${t.command.slice(0, 40)}` })
      .catch(() => {})
  }
  mcpManagerRef = deps.mcpManager
  sessionEndHook = deps.hookRunner

  // M6 S-P8：skill 发现（项目级+用户级扫描；失败静默——skill 缺失不阻塞启动）
  await skillRegistry.load({ builtinCommandNames: commandRegistry.list().map((c) => c.name) }).catch(() => {})
  for (const w of skillRegistry.loadWarnings) logger.warn('skill', 'load_warning', { message: w })
  logger.info('skill', 'loaded', { count: skillRegistry.list().length })

  // M7 P-P6：plugin 资源接入（skills→addSource / mcp→命名空间 server / hooks→扩展注册表）
  const pluginWarnings = await deps.pluginLoader
    ?.loadAll(skillRegistry, deps.mcpManager)
    .catch((e: unknown) => [`plugin loadAll 失败：${e instanceof Error ? e.message : String(e)}`]) ?? []
  for (const w of pluginWarnings) logger.warn('plugin', 'load_warning', { message: w })
  if (deps.pluginLoader !== null) {
    logger.info('plugin', 'loaded', { count: deps.pluginLoader.list().length })
  }

  // argv 单次模式：M1 stdout 输出 → 跑一次退出（graceful：SessionEnd/MCP 清理走预算窗口）
  // D1（B2）：--yes 显式放行 tool-confirm 类审批（sensitive/mcp-permission 不豁免）；缺省 fail-closed
  const initialInput = process.argv
    .slice(2)
    .filter((a) => a !== '--yes')
    .join(' ')
    .trim()
  if (initialInput) {
    for (const w of deps.instructionWarnings) process.stderr.write(`⚠ ${w}
`)
    try {
      await runOnce(initialInput, deps, autoYes ? 'auto-approve' : 'ask') // policy 兜底（project 路径已在装配点生效）
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      gracefulShutdown(1)
      return
    }
    gracefulShutdown(0)
    return
  }

  // REPL 模式：Ink TUI（exitOnCtrlC:false，由 TuiApp 的 useInterrupt 自处理双击退出——
  // 双击走 gracefulShutdown：恢复终端 → SessionEnd hooks → MCP stop → exit）
  const instance = render(
    React.createElement(TuiApp, {
      deps,
      banner,
      onRestart: () => restartProcess(instance),
      onExit: () => gracefulShutdown(0),
    }),
    { exitOnCtrlC: false },
  )
  inkApp = instance
}

/**
 * /restart（拍板 ②）：unmount 恢复终端态 → spawn 新实例（argv 原样重放，detached 新进程组
 * 不随旧进程死）→ 延迟 exit 给新旧进程交接终端（短暂闪屏可接受）。会话历史已由
 * HistoryStore 持久化，新实例 /history 可恢复。
 */
function restartProcess(instance: { unmount(): void }): void {
  try {
    instance.unmount()
  } catch {
    // unmount 竞态不阻塞重启
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: 'inherit',
  })
  child.unref()
  child.on('error', (e) => {
    process.stderr.write(`✗ 重启失败：${e.message}（请手动重新运行）\n`)
  })
  setTimeout(() => process.exit(0), 200)
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
