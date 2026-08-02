#!/usr/bin/env node

/**
 * ECode — 手写 AI coding agent（M2：多模型 Provider 抽象）
 *
 * 使用:
 *   ecode [--model <name>] [--list-models] <任务描述>
 *   ecode "读 package.json 告诉我依赖"
 *   ecode --model glm-5.2 "改 src/agent.ts 的 xxx"
 *   ecode --list-models
 *
 * 模型配置见 ~/.ecode/config.json（不存在则用内置默认：GLM/DeepSeek/Claude）。
 * 各 provider 的 API Key 通过环境变量传入（config.json 的 apiKeyEnv 指向变量名），
 * .env 由 `npm run dev`（tsx --env-file-if-exists）自动加载。
 */

import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { listAvailableModels } from './providers/config.js';

const { values, positionals } = parseArgs({
  options: {
    model: { type: 'string' },
    'list-models': { type: 'boolean' },
  },
  allowPositionals: true,
});

if (values['list-models']) {
  console.log('可用模型：');
  for (const m of listAvailableModels()) {
    console.log(`  ${m.model} (provider: ${m.provider})`);
  }
  process.exit(0);
}

const task = positionals[0];
if (!task) {
  console.error('用法: ecode [--model <name>] [--list-models] <任务描述>');
  console.error('示例: ecode "读 package.json 告诉我依赖"');
  process.exit(1);
}

runAgent(task, values.model).catch((err) => {
  console.error('\n💥 致命错误:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
