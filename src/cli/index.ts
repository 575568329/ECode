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
import { evalPermission, loadPermissionLayers, saveLocalPermission, askPermissionInteractive } from '../services/permissions.js'
import { runLoop } from '../core/loop.js'
import { buildSystemPrompt } from '../core/system.js'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { render } from 'ink'
import React from 'react'
import { TuiApp } from '../tui/TuiApp.js'
import { registerBuiltinCommands, commandRegistry } from '../commands/registry.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { makeOnBeforeRequest } from '../services/compaction/hook.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../services/compaction/summarize.js'
import { skillRegistry, createSkillRegistry } from '../services/skill.js'
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
import type { HistoryLine } from '../core/types.js'

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
}

function makeDeps(config: Config, logger: Logger, sessionId: string): Deps {
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
  // 扩展源用全局注册表（skill/plugin 的注册入口分散在 Tool/TuiApp，全局单例免依赖穿透）
  const { hooks: userHooks, warnings: hookWarnings } = parseUserHooks(config.hooks)
  for (const w of hookWarnings) logger.warn('hooks', 'user_config', { message: w })
  // M9-P5：扩展源 hook 权限门（Hook(owner) 三态；用户源无 owner 不问）。
  // once 允许后本会话同 owner:event 不再问（session 记忆）；remember 落 local 层 settings.local.json。
  const permSessionAllowed = new Set<string>()
  const hookRunner = new HookRunner({
    extensions: globalExtensionHooks,
    execute: runCommandHook,
    getUserHooks: () => userHooks,
    getSessionId: () => sessionId,
    warn: (m) => logger.warn('hooks', 'exec', { message: m }),
    checkHookPermission: async (owner, event) => {
      const key = `${owner}:${event}`
      if (permSessionAllowed.has(key)) return true
      const resource = `Hook(${owner})`
      const behavior = evalPermission(resource, loadPermissionLayers(process.cwd()))
      if (behavior === 'allow') return true
      if (behavior === 'deny') return false
      const answer = await askPermissionInteractive(owner, event)
      if (answer === null) {
        logger.warn('hooks', 'permission', { message: `无交互界面，ask 默认拒绝：${resource} → ${event}` })
        return false
      }
      if (answer.allow) {
        permSessionAllowed.add(key)
        if (answer.remember) saveLocalPermission(process.cwd(), 'allow', resource)
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
  return {
    providerRegistry: providerReg,
    tools: hookedTools,
    logger,
    history: new FileHistoryStore({ sessionId, model: config.current.model }),
    checkpoint: new CheckpointStore(process.cwd(), {
      warn: (m) => logger.warn('checkpoint', 'snapshot', { message: m }),
    }),
    quality: new QualityGate({
      commands: detectQualityCommands(process.cwd(), { lintCommand: config.lintCommand, testCommand: config.testCommand }),
      run: makeShellRunner(process.cwd()),
      warn: (m) => logger.warn('quality', 'gate', { message: m }),
    }),
    config,
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry,
    mcpManager: mcp.manager,
    mcpWarnings: mcp.warnings,
    instructionWarnings,
    hookRunner,
    pluginLoader: new PluginLoader({ warn: (m) => logger.warn('plugin', 'load', { message: m }) }),
    ...(mcp.pendingApproval !== undefined ? { mcpPendingApproval: mcp.pendingApproval } : {}),
  }
}

/** argv 单次模式：M1 stdout 输出（流式打印 + 工具摘要）。 */
/** buildSystemPrompt 的上限透传（config maxInstructionsKB → 字节）。 */
function buildPromptOpts(config: Config): { maxInstructionBytes?: number } | undefined {
  return config.maxInstructionsKB !== undefined ? { maxInstructionBytes: config.maxInstructionsKB * 1024 } : undefined
}

async function runOnce(messages: HistoryLine[], input: string, deps: Deps): Promise<void> {
  const provider = deps.providerRegistry.getByType(deps.config.providers[deps.config.current.name].type)
  const providerReq = buildProviderReq(deps.config)
  const ctxWindow = await resolveContextWindow(
    deps.config.current.model,
    deps.config.providers[deps.config.current.name]?.contextWindow,
  )
  const system = buildSystemPrompt(deps.skillRegistry.listForPrompt(), ctxWindow, buildPromptOpts(deps.config))
  const onCompacted = (_messages: HistoryLine[]) => process.stdout.write('\n[已压缩对话]\n')
  const onBeforeRequest = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, system, {
    onCompacted,
    history: deps.history,
    tools: deps.tools.specs(),
  })
  await runLoop(messages, input, {
    provider,
    tools: deps.tools,
    logger: deps.logger,
    history: deps.history,
    callbacks: {
      onText: (t) => process.stdout.write(t),
      onToolStart: (name) => process.stdout.write(`\n⏺ ${name}\n`),
      onToolResult: (_id, name, r) => {
        const firstLine = r.content.split('\n')[0]?.slice(0, 80) ?? ''
        process.stdout.write(`  ${name} ${r.is_error ? '✗' : '✓'} ${firstLine}\n`)
      },
      onUsage: (inp, out, cache) => {
        deps.lastUsage.input = inp
        deps.lastUsage.output = out
        deps.lastUsage.cacheRead = cache?.read ?? 0
        deps.lastUsage.cacheCreation = cache?.creation ?? 0
        process.stdout.write(`\n[tokens: in ${inp} / out ${out}]\n`)
      },
      onWarn: (m) => process.stdout.write(`\n⚠ ${m}\n`),
    },
    providerReq,
    system,
    maxIterations: deps.config.maxIterations,
    toolCtx: {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      // M9-P1：写前快照装配（argv 单次模式同款；快照失败工具侧已 catch）
      onBeforeWrite: async (paths, tool, toolUseId) => {
        await deps.checkpoint?.snapshot(deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
      },
      // M10-P0：无视觉能力守卫（argv 同款）
      model: deps.config.current.model,
      // M9-P4：argv 模式按 config 默认档装配（deny 校验仍拦；argv 本就无交互确认）
      sandbox: makeSandbox(
        (deps.config.sandbox?.defaultMode as 'default' | 'read-only' | 'workspace-write' | 'full-access') ?? 'default',
        process.cwd(),
        deps.config.sandbox?.blockedCommands ?? [],
      ),
    },
    onBeforeRequest,
    onCompacted,
    // M9-P3：轮末质量回喂（argv 单次模式同款）
    afterTools: deps.quality
      ? async (round) => {
          const fb = await deps.quality?.afterRound(round.tools)
          return fb !== undefined ? { feedback: fb } : undefined
        }
      : undefined,
  })
  process.stdout.write('\n')
}

async function main(): Promise<void> {
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

  const deps = makeDeps(config, logger, sessionId)
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
  const initialInput = process.argv.slice(2).join(' ').trim()
  if (initialInput) {
    for (const w of deps.instructionWarnings) process.stderr.write(`⚠ ${w}
`)
    const messages: HistoryLine[] = []
    try {
      await runOnce(messages, initialInput, deps)
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
