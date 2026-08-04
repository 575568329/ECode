#!/usr/bin/env node

/**
 * ECode — 手写 AI coding agent
 *
 * 使用:
 *   ecode "<任务>"                    开始新会话
 *   ecode --continue                  恢复最近会话(打印摘要,不调 LLM)
 *   ecode -c "新指令"                 续接最近会话(--continue 简写)
 *   ecode --resume <id>               恢复指定会话(打印摘要,不调 LLM)
 *   ecode --resume <id> "新指令"      续接指定会话
 *   ecode --sessions                  列出本项目全部会话(不调 LLM)
 *   ecode --model <name> "<任务>"     指定模型
 *   ecode --list-models               列出可用模型
 *
 * 会话历史落盘 .ecode/sessions/(已 gitignore)。
 * 模型配置见 ~/.ecode/config.json;API Key 通过环境变量传入,.env 由 npm run dev 自动加载。
 */

import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { listAvailableModels } from './providers/config.js';
import { listSessions, loadSession, latestSessionId, SessionNotFoundError } from './session.js';
import type { ECodeSession } from './session.js';

const { values, positionals } = parseArgs({
  options: {
    model: { type: 'string' },
    'list-models': { type: 'boolean' },
    sessions: { type: 'boolean' },
    continue: { type: 'boolean', short: 'c' }, // -c 简写
    resume: { type: 'string' },
  },
  allowPositionals: true,
});

// ============================================================
// 工具函数
// ============================================================

/** ISO → 本地可读 "YYYY-MM-DD HH:mm:ss"。 */
function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

/** 提取最后一条 assistant 的文本(纯恢复摘要预览用)。无则返回空串。 */
function lastAssistantText(session: ECodeSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content;
    const textBlock = msg.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') return textBlock.text;
  }
  return '';
}

/** 统一的致命错误出口。 */
function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

/** 打印用法。 */
function printUsage(): void {
  console.error('用法: ecode [选项] <任务描述>\n');
  console.error('  ecode "<任务>"                    开始新会话');
  console.error('  ecode --continue                  恢复最近会话(不调 LLM)');
  console.error('  ecode -c "新指令"                 续接最近会话');
  console.error('  ecode --resume <id>               恢复指定会话(不调 LLM)');
  console.error('  ecode --resume <id> "新指令"      续接指定会话');
  console.error('  ecode --sessions                  列出全部会话');
  console.error('  ecode --model <name> "<任务>"     指定模型');
  console.error('  ecode --list-models               列出可用模型');
}

// ============================================================
// 命令分流
// ============================================================

// ---- --list-models ----
if (values['list-models']) {
  console.log('可用模型：');
  for (const m of listAvailableModels()) {
    console.log(`  ${m.model} (provider: ${m.provider})`);
  }
  process.exit(0);
}

// ---- --sessions:列出全部会话(不调 LLM)----
if (values.sessions) {
  const list = listSessions();
  if (list.length === 0) {
    console.log('暂无会话记录。');
    process.exit(0);
  }
  console.log('会话列表(按更新时间倒序):\n');
  console.log('ID                更新时间              轮数  工具调用  任务');
  for (const s of list) {
    const taskPreview = s.task.length > 30 ? `${s.task.slice(0, 30)}...` : s.task;
    console.log(
      `${s.id.padEnd(18)}${formatTime(s.updatedAt).padEnd(22)}${String(s.stats.rounds).padStart(4)}  ${String(s.stats.toolCalls).padStart(8)}  ${taskPreview}`,
    );
  }
  process.exit(0);
}

// ---- --continue / --resume:续接族 ----
const wantContinue = values['continue'] === true;
const wantResume = values.resume !== undefined;

if (wantContinue || wantResume) {
  // 确定 id:--continue 取最近;--resume 用指定值
  const id = wantContinue ? latestSessionId() : values.resume;
  if (!id) {
    fatal('没有可恢复的会话。用 ecode "<任务>" 开始新会话,或 ecode --sessions 查看。');
  }

  let session: ECodeSession;
  try {
    session = loadSession(id);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      fatal(`找不到会话 ${id}。用 ecode --sessions 查看会话列表。`);
    }
    fatal(`加载会话 ${id} 失败:${err instanceof Error ? err.message : String(err)}`);
  }

  const newTask = positionals[0];

  // 无任务 → 纯恢复:打印详情摘要,不调 LLM(决策①)
  if (!newTask) {
    const preview = lastAssistantText(session).slice(0, 200).replace(/\n/g, ' ');
    console.log(`\n📋 会话 ${session.id}`);
    console.log(`   任务: ${session.task}`);
    console.log(`   模型: ${session.model}`);
    console.log(
      `   轮数: ${session.stats.rounds} | 工具调用: ${session.stats.toolCalls}${session.stats.compressed ? ' | (已压缩)' : ''}`,
    );
    console.log(`   创建: ${formatTime(session.createdAt)} | 更新: ${formatTime(session.updatedAt)}`);
    console.log(`   消息: ${session.messages.length} 条`);
    if (preview) {
      console.log(`   最后回复: ${preview}`);
    }
    console.log('\n(纯恢复模式,未调用 LLM。要继续对话:ecode --continue "新指令")\n');
    process.exit(0);
  }

  // 有任务 → 续接跑(复用原 id 续写同一文件,决策③A)
  runAgent(newTask, values.model, {
    resumed: {
      id: session.id,
      task: session.task,
      createdAt: session.createdAt,
      messages: session.messages,
    },
  }).catch((err) => {
    console.error('\n💥 致命错误:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // ---- 新会话(现状)----
  const task = positionals[0];
  if (!task) {
    printUsage();
    process.exit(1);
  }
  runAgent(task, values.model).catch((err) => {
    console.error('\n💥 致命错误:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
