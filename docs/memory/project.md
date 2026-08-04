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
src/session.ts        Session 持久化（P4）：save/load/list/latestSessionId + taskToSlug
                      纯数据层零 LLM 依赖；原子写 tmp+rename；同 id=覆盖(剔除 -2)
```

**硬约束**：
- `tool_result.tool_use_id` == `tool_use.id`（不配对 → API 400）
- `messages` 累加（append，不重建），每轮传完整历史
- ESM：import 带 `.js`；tsconfig strict + `noUnusedLocals/Parameters`

## 里程碑

| 里程碑 | 学习目标 | 状态 |
|--------|---------|------|
| M1 Agent Loop | 工具调用协议、while 循环、id 配对 | ✅ 完成 |
| M2 多模型适配 | Provider 抽象、协议差异、能力探测 | ✅ 完成 |
| M3 上下文压缩 + Session | token 计数、摘要压缩、结果截断、Session 持久化 | 🟡 P1-P4 完成（超限恢复插队完成），P5 待 |
| M3.5 交互式 CLI | 沉浸 REPL、slash 命令、流式渲染、中断、富文本/TUI | ⬜ 规划中 |
| M4 权限系统 | default/acceptEdits/plan/bypass、危险命令拦截 | ⬜ 未开始 |
| M5+ 进阶 | 可观测性 / Repo Map / Subagent | ⬜ 未开始 |

## 当前焦点

**M3 P1-P4 完成**（2026-08-03）：上下文管理 + Session 持久化落地。
- ✅ P1 格式 v2（声明式工具，executor 纯 find+execute 分发，无 switch/case）
- ✅ P2 token 计数（`length/4` 粗估，零依赖，仿 Claude Code）+ 截断（tool_result 内容截断）
- ✅ P3 上下文压缩（maybeCompress 级联：trim tool_result 内容 → summary；trim 保留 tool_use_id 配对不断裂）
- ✅ 超限恢复插队（L2 trim / L3 forceCompact 响应式 / L4 熔断，仿 Claude Code reactiveCompact）
- ✅ **P4 Session 持久化**：`src/session.ts`（纯数据层，原子写 tmp+rename，覆盖语义剔除 -2）+ agent loop 挂载（首轮/每轮末/压缩后/结束）+ CLI `--continue`/`-c`/`--resume`/`--sessions`（不带任务=纯恢复不调 LLM）。设计见 [M3-实施方案.md](../M3-实施方案.md) §6，剔除 -2 决策见 [decisions.md #002](./decisions.md)
- ✅ 151 单测（session 21 + context-resilience 20 + …）；tsc clean
- 🟡 真实 LLM 端到端落盘：待配 `.env` key 实跑（单测 + tsc + CLI 免费分流已验证）
- ⬜ P5 伴随特性（并行只读工具 / retry 读 Retry-After / usage 细化）→ M3.5 交互式 CLI

**M2 完成**（2026-08-02）：Provider 抽象层落地，agent 解耦 SDK。
- Provider 层（types/transform/claude/openai/config/factory）+ tools 协议中立化 + CLI --model/--list-models
- OpenAI 协议端到端实跑通过（deepseek-chat，含工具调用）

> M2 配置变化：从 M1 的 `ANTHROPIC_AUTH_TOKEN`+Anthropic 兼容端点，改为 config.json 驱动的 `DEEPSEEK_API_KEY`/`ZHIPUAI_API_KEY`（OpenAI 兼容协议，openai SDK）。

## 关键文档

- `docs/00-开发规划.md` — 总规划与里程碑
- `docs/M1-技术选型与理由.md` — 选型决策（ESM / Vitest / tsx / tsconfig）
- `docs/M1-实施方案.md` — 骨架记录 + M1 补全清单 + 验收
- `docs/M1-方案解析.md` — 协议/SDK 原理 + 设计答疑（合并原 03/04/notes）
- `docs/M2-实施方案.md` / `M2-方案解析.md` — Provider 抽象层（接口/翻译/能力探测）
- `docs/借鉴Vercel-AI-SDK对比报告.md` — 11 个借鉴点（Top5 优先级 + 演进路线）
- `docs/M3-实施方案.md` / `M3-方案解析.md` — 上下文管理 + Session（5 Phase + 压缩算法）⬜ 待审阅

## 环境

- 运行：`npm run dev -- "任务"`（自动加载 `.env`，via `tsx --env-file-if-exists`）
- 默认走 DeepSeek 兼容端点：`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，默认模型 `deepseek-v4-pro`
- 切官方 Claude：改用 `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL=claude-sonnet-4-20250514`，留空 BASE_URL
- Node >= 18（实测 v22.22.2）
