#!/usr/bin/env node

/**
 * ECode — 手写 AI coding agent
 * M1: 最小可运行 agent loop
 *
 * 使用:
 *   ecode "你的任务描述"
 *   ecode "读 package.json 告诉我依赖"
 *
 * 环境变量:
 *   ANTHROPIC_API_KEY  — Claude API Key（必填）
 *   ANTHROPIC_MODEL    — 模型名（可选，默认 claude-sonnet-4-20250514）
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
