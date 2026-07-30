# ECode 项目上下文

> 项目状态记忆。跨设备同步（git 跟踪）。AI 会话开始时读这个文件对齐当前进度。

## 是什么

**手写 AI coding agent**——**开源产品**（对标 Claude Code / opencode），认真一步步开发交付。手写 agent loop（不用 LangGraph 等框架），追求稳定、完整、可维护。

> 定位变更（2026-07-30）：从"学习项目（理解优先、YAGNI）"转为"开源产品（交付优先）"。质量标准随之提高：测试覆盖、错误恢复、权限、文档都是必须项，不再"用到再加"。

- 单包 CLI，TypeScript + Node.js（ESM）
- 核心是手写的 agent loop（while 循环 + tool_use/tool_result 配对）

## 架构骨架

```
src/index.ts          CLI 入口，解析 argv[2] 作为任务
  └─ runAgent(task)   [src/agent.ts] agent loop 主体
       for (最多 MAX_ITERATIONS=25 轮):
         1. anthropic.messages.create({ messages, tools })
         2. text block → stdout；tool_use block → 收集
         3. 无 tool_use → break（最终答案）
         4. assistant 回复原样 push 进 messages
         5. executeTool → push tool_result（id 必须配对）
src/tools.ts          工具定义(Anthropic input_schema) + 执行器(switch 分发)
                      新增工具：toolDefinitions 和 executeTool 两处都要改
src/runtime-logger.ts 每次运行写 docs/logs/runtime/YYYY-MM-DD/HHmmss.md
                      (appendFileSync，崩溃日志不丢)
```

**硬约束**：
- `tool_result.tool_use_id` == `tool_use.id`（不配对 → API 400）
- `messages` 累加（append，不重建），每轮传完整历史
- ESM：import 带 `.js`；tsconfig strict + `noUnusedLocals/Parameters`

## 里程碑

| 里程碑 | 学习目标 | 状态 |
|--------|---------|------|
| M1 Agent Loop | 工具调用协议、while 循环、id 配对 | 🔄 补全中（能跑，补到"真能用"） |
| M2 多模型适配 | Provider 抽象、协议差异、能力探测 | ⬜ 未开始 |
| M3 上下文压缩 | token 计数、摘要压缩、结果截断 | ⬜ 未开始 |
| M4 权限系统 | default/acceptEdits/plan/bypass、危险命令拦截 | ⬜ 未开始 |
| M5+ 进阶 | 可观测性 / Repo Map / Subagent | ⬜ 未开始 |

## 当前焦点

**M1 补全到"真能用"**（交付标准，不再是学习收尾）：
- 补测试（纯函数 + Mock SDK，TDD 基础）
- System Prompt（分层，模型认知 + 行为约束）
- 错误恢复（API 重试 429/529、死循环防护加强）
- 工具补全（edit_file / grep / glob）
- 后置验证（强制 build/test，不信模型自报完成）

## 关键文档

- `docs/00-开发规划.md` — 总规划与里程碑
- `docs/01-技术栈选型与理由.md` — 选型决策
- `docs/02-M1骨架搭建方案.md` — M1 方案
- `docs/03-Anthropic-SDK-参数详解.md` — SDK 参数
- `docs/04-OpenAI-vs-Anthropic-API协议对比.md` — M2 前置

## 环境

- 运行：`npm run dev -- "任务"`（自动加载 `.env`，via `tsx --env-file-if-exists`）
- 默认走 DeepSeek 兼容端点：`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，默认模型 `deepseek-v4-pro`
- 切官方 Claude：改用 `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL=claude-sonnet-4-20250514`，留空 BASE_URL
- Node >= 18（实测 v22.22.2）
