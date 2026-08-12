#!/usr/bin/env node
/**
 * ECode CLI 入口（M1）。
 *
 * 两种模式：
 *   - 单次：`ecode "你的问题"` 或 `npm run dev -- "问题"` → 跑一次退出
 *   - REPL：`ecode` 或 `npm run dev` → 交互式循环（Ctrl+C 退出）
 *
 * readline 纯文本（TUI 留 M2）。加载 config → 注册 provider/tools → runLoop。
 */

import * as readline from 'node:readline'
import { loadConfig, type M1Config } from '../services/config.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { LLMProviderRegistryImpl } from '../providers/registry.js'
import { ToolRegistryImpl } from '../tools/registry.js'
import { readFileTool } from '../tools/builtin/read_file.js'
import { bashTool } from '../tools/builtin/bash.js'
import { ConsoleLogger } from '../services/logger.js'
import { NoopHistoryStore } from '../services/history.js'
import { runLoop } from '../core/loop.js'
import type { LLMProvider } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import type { Message } from '../core/types.js'

const SYSTEM_PROMPT = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令，帮用户完成编程任务。
当前工作目录：${process.cwd()}
当前平台：${process.platform}
回复用中文。`

interface Deps {
  provider: LLMProvider
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  cfg: M1Config
}

function makeDeps(cfg: M1Config): Deps {
  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  const toolReg = new ToolRegistryImpl()
  toolReg.register(readFileTool)
  toolReg.register(bashTool)
  return {
    provider: providerReg.getByType(cfg.type),
    tools: toolReg,
    logger: new ConsoleLogger(),
    history: new NoopHistoryStore(),
    cfg,
  }
}

/** 跑一次对话（可能内部多轮工具调用）。单次模式和 REPL 的 'line' 共用。 */
async function runOnce(messages: Message[], input: string, deps: Deps): Promise<void> {
  await runLoop(messages, input, {
    provider: deps.provider,
    tools: deps.tools,
    logger: deps.logger,
    history: deps.history,
    callbacks: {
      onText: (t) => process.stdout.write(t),
      onToolStart: (name) => process.stdout.write(`\n⏺ ${name}\n`),
      onToolResult: (name, r) => {
        const firstLine = r.content.split('\n')[0]?.slice(0, 80) ?? ''
        process.stdout.write(`  ${name} ${r.is_error ? '✗' : '✓'} ${firstLine}\n`)
      },
      onUsage: (inp, out) => process.stdout.write(`\n[tokens: in ${inp} / out ${out}]\n`),
      onWarn: (m) => process.stdout.write(`\n⚠ ${m}\n`),
    },
    providerReq: {
      name: deps.cfg.providerName,
      baseURL: deps.cfg.baseURL,
      apiKey: deps.cfg.apiKey,
      model: deps.cfg.model,
    },
    system: SYSTEM_PROMPT,
    maxIterations: deps.cfg.maxIterations,
    // M2 才做真中断（透传 signal 给流式请求）；M1 每轮独立 controller
    toolCtx: { cwd: process.cwd(), signal: new AbortController().signal },
  })
  process.stdout.write('\n')
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  console.log(`ECode M1 · ${cfg.model} · ${cfg.providerName}（${cfg.type}）`)
  const deps = makeDeps(cfg)
  const messages: Message[] = []

  // 单次模式：argv 带初始问题 → 跑一次退出
  const initialInput = process.argv.slice(2).join(' ').trim()
  if (initialInput) {
    try {
      await runOnce(messages, initialInput, deps)
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  // REPL 模式
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '❯ ',
  })
  console.log('输入问题开始（Ctrl+C 退出）\n')
  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }
    try {
      await runOnce(messages, input, deps)
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
    }
    rl.prompt()
  })

  rl.on('close', () => {
    process.stdout.write('\n再见\n')
    process.exit(0)
  })
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
