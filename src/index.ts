#!/usr/bin/env node

/**
 * ECode — 手写 AI coding agent
 * M1: 最小可运行 agent loop
 *
 * 使用:
 *   ecode "你的任务描述"
 *   ecode "读 package.json 告诉我依赖"
 *
 * 环境变量（见 .env.example，默认走 DeepSeek 兼容端点）:
 *   ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY — 鉴权（二选一，必填）
 *   ANTHROPIC_BASE_URL — 兼容端点（DeepSeek: https://api.deepseek.com/anthropic）
 *   ANTHROPIC_MODEL    — 模型名（可选，默认 deepseek-v4-pro）
 *
 * .env 由 `npm run dev`（tsx --env-file-if-exists）自动加载，无需手动 export。
 */

import { runAgent } from './agent.js';

const task = process.argv[2];

if (!task) {
  console.error('用法: ecode <任务描述>');
  console.error('示例: ecode "读 package.json 告诉我依赖"');
  process.exit(1);
}

runAgent(task).catch((err) => {
  console.error('\n💥 致命错误:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
