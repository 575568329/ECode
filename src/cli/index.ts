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
import { readFileTool } from '../tools/builtin/read_file.js'
import { bashTool } from '../tools/builtin/bash.js'
import { lsTool } from '../tools/builtin/ls.js'
import { globTool } from '../tools/builtin/glob.js'
import { grepTool } from '../tools/builtin/grep.js'
import { writeFileTool } from '../tools/builtin/write_file.js'
import { editFileTool } from '../tools/builtin/edit_file.js'
import { JsonlLogger } from '../services/logger.js'
import { LogStore } from '../services/logstore.js'
import { FileHistoryStore } from '../services/history.js'
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
import { skillTool } from '../tools/builtin/skill.js'
import { skillRegistry, createSkillRegistry } from '../services/skill.js'
import { setupMcp } from '../services/mcp/setup.js'
import type { McpManager } from '../services/mcp/manager.js'
import { globalExtensionHooks } from '../services/hooks/global.js'
import { HookRunner } from '../services/hooks/runner.js'
import { parseUserHooks } from '../services/hooks/validate.js'
import { runCommandHook } from '../services/hooks/exec.js'
import { HookedToolRegistry } from '../tools/hooked.js'
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
  hookRunner: HookRunner | null
  pluginLoader: PluginLoader | null
}

function makeDeps(config: Config, logger: Logger, sessionId: string): Deps {
  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  providerReg.register(new OpenaiProvider())
  const toolReg = new ToolRegistryImpl()
  toolReg.register(readFileTool)
  toolReg.register(bashTool)
  toolReg.register(lsTool)
  toolReg.register(globTool)
  toolReg.register(grepTool)
  toolReg.register(writeFileTool)
  toolReg.register(editFileTool)
  toolReg.register(skillTool)
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
  const hookRunner = new HookRunner({
    extensions: globalExtensionHooks,
    execute: runCommandHook,
    getUserHooks: () => userHooks,
    getSessionId: () => sessionId,
    warn: (m) => logger.warn('hooks', 'exec', { message: m }),
  })
  let hookRunnerRef: HookRunner | null = hookRunner
  const hookedTools = new HookedToolRegistry(toolReg, () => hookRunnerRef)
  return {
    providerRegistry: providerReg,
    tools: hookedTools,
    logger,
    history: new FileHistoryStore({ sessionId, model: config.current.model }),
    config,
    orchestrator,
    lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    skillRegistry,
    mcpManager: mcp.manager,
    mcpWarnings: mcp.warnings,
    hookRunner,
    pluginLoader: new PluginLoader({ warn: (m) => logger.warn('plugin', 'load', { message: m }) }),
    ...(mcp.pendingApproval !== undefined ? { mcpPendingApproval: mcp.pendingApproval } : {}),
  }
}

/** argv 单次模式：M1 stdout 输出（流式打印 + 工具摘要）。 */
async function runOnce(messages: HistoryLine[], input: string, deps: Deps): Promise<void> {
  const provider = deps.providerRegistry.getByType(deps.config.providers[deps.config.current.name].type)
  const providerReq = buildProviderReq(deps.config)
  const ctxWindow = await resolveContextWindow(
    deps.config.current.model,
    deps.config.providers[deps.config.current.name]?.contextWindow,
  )
  const system = buildSystemPrompt(deps.skillRegistry.listForPrompt(), ctxWindow)
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
    toolCtx: { cwd: process.cwd(), signal: new AbortController().signal },
    onBeforeRequest,
    onCompacted,
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
  // M7 H-P4：SessionEnd hook（best-effort——exit 内不能 await，fire 后事件循环将停；
  // 长耗时的 SessionEnd hook（如清理脚本）可能被截断，属已知限制，可靠清理走 Stop/工具层）
  let sessionEndHook: HookRunner | null = null
  // P1-8：exit handler 注册序 = 执行序（先杀子进程再 flush 日志——子进程 stderr 尾巴也能进日志）
  process.on('exit', () => {
    void sessionEndHook?.dispatch('SessionEnd', { event: 'SessionEnd', session_id: '' }).catch(() => {})
    void mcpManagerRef?.stop()
  })
  process.on('exit', () => {
    logger.info('system', 'shutdown', { exitCode: process.exitCode })
    logStore.close()
  })
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

  // argv 单次模式：M1 stdout 输出 → 跑一次退出
  const initialInput = process.argv.slice(2).join(' ').trim()
  if (initialInput) {
    const messages: HistoryLine[] = []
    try {
      await runOnce(messages, initialInput, deps)
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  // REPL 模式：Ink TUI（exitOnCtrlC:false，由 TuiApp 的 useInterrupt 自处理双击退出）
  const instance = render(
    React.createElement(TuiApp, { deps, banner, onRestart: () => restartProcess(instance) }),
    { exitOnCtrlC: false },
  )
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
