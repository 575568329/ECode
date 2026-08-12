#!/usr/bin/env node
/**
 * ECode CLI 入口（M1）。
 *
 * readline 纯文本 REPL（TUI 留 M2）。加载 config → 注册 provider/tools →
 * 循环读取输入 → runLoop → 流式打印到 stdout。
 *
 * Ctrl+C 退出（M2 才做「一次中断、两次退出」+ 工具确认的 TUI 交互）。
 */

import * as readline from 'node:readline'
import { loadConfig } from '../services/config.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { LLMProviderRegistryImpl } from '../providers/registry.js'
import { ToolRegistryImpl } from '../tools/registry.js'
import { readFileTool } from '../tools/builtin/read_file.js'
import { bashTool } from '../tools/builtin/bash.js'
import { ConsoleLogger } from '../services/logger.js'
import { NoopHistoryStore } from '../services/history.js'
import { runLoop } from '../core/loop.js'
import type { Message } from '../core/types.js'

const SYSTEM_PROMPT = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令，帮用户完成编程任务。
当前工作目录：${process.cwd()}
当前平台：${process.platform}
回复用中文。`

async function main(): Promise<void> {
  // 1) 加载 config（无 config 会抛清晰错误，提示手建）
  const cfg = loadConfig()
  console.log(`ECode M1 · ${cfg.model} · ${cfg.providerName}（${cfg.type}）`)

  // 2) 注册 provider（两层：实现按 type）
  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  const provider = providerReg.getByType(cfg.type)

  // 3) 注册 tools（M1：read_file + bash）
  const toolReg = new ToolRegistryImpl()
  toolReg.register(readFileTool)
  toolReg.register(bashTool)

  const logger = new ConsoleLogger()
  const history = new NoopHistoryStore()
  const messages: Message[] = []

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
      await runLoop(messages, input, {
        provider,
        tools: toolReg,
        logger,
        history,
        callbacks: {
          onText: (t) => process.stdout.write(t),
          onToolStart: (name) => process.stdout.write(`\n⏺ ${name}`),
          onToolResult: (name, r) => {
            const firstLine = r.content.split('\n')[0]?.slice(0, 80) ?? ''
            process.stdout.write(`  ${name} ${r.is_error ? '✗' : '✓'} ${firstLine}\n`)
          },
          onUsage: (inp, out) => process.stdout.write(`\n[tokens: in ${inp} / out ${out}]\n`),
          onWarn: (m) => process.stdout.write(`\n⚠ ${m}\n`),
        },
        providerReq: {
          name: cfg.providerName,
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model,
        },
        system: SYSTEM_PROMPT,
        maxIterations: cfg.maxIterations,
        toolCtx: { cwd: process.cwd(), signal: new AbortController().signal },
      })
      process.stdout.write('\n')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`\n✗ ${msg}\n`)
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
