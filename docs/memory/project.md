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
| M3 上下文压缩 + Session | token 计数、摘要压缩、结果截断、Session 持久化 | 🟡 P1-P4 完成，P5 待（⚠️ 超限响应式恢复 L3 未接线，见 [审查报告](../总纲/ECode项目审查报告.md) 🔴-1）|
| M3.5 交互式 CLI | 沉浸 REPL、slash 命令、流式渲染、中断、富文本/TUI | 🟡 进行中（REPL/斜杠/折叠组/pager/会话切换/**Esc-Ctrl+C 分工**已落地，Ctrl+O B+ 精简代码完成待真机）|
| M4 权限系统 | default/acceptEdits/plan/bypass、危险命令拦截 | ⬜ 未开始 |
| M5+ 进阶 | 可观测性 / Repo Map / Subagent | ⬜ 未开始 |

## 当前焦点

**M3 P1-P4 完成**（2026-08-03）：上下文管理 + Session 持久化落地。
- ✅ P1 格式 v2（声明式工具，executor 纯 find+execute 分发，无 switch/case）
- ✅ P2 token 计数（`length/4` 粗估，零依赖，仿 Claude Code）+ 截断（tool_result 内容截断）
- ✅ P3 上下文压缩（maybeCompress 级联：trim tool_result 内容 → summary；trim 保留 tool_use_id 配对不断裂）
- ✅ 超限恢复插队——**L3 响应式已接线**（2026-08-07 修复）：agent.ts 内加 inner try-catch，API 报 context window 超限 → forceCompact 压缩 → 自动重试（含连续失败计数器 + L4 熔断防护）。单测"context window 超限"端到端绿。
- ✅ **P4 Session 持久化**：`src/session.ts`（纯数据层，原子写 tmp+rename，覆盖语义剔除 -2）+ agent loop 挂载（首轮/每轮末/压缩后/结束）+ CLI `--continue`/`-c`/`--resume`/`--sessions`（不带任务=纯恢复不调 LLM）。设计见 [M3-实施方案.md](../里程碑/M3-实施方案.md) §6，剔除 -2 决策见 [decisions.md #002](./decisions.md)
- ✅ 151 单测（session 21 + context-resilience 20 + …）；tsc clean
- 🟡 真实 LLM 端到端落盘：待配 `.env` key 实跑（单测 + tsc + CLI 免费分流已验证）
- ⬜ P5 伴随特性（并行只读工具 / retry 读 Retry-After / usage 细化）

**M3.5 交互式 CLI 进行中**（2026-08 起，单测 400 绿）：
- ✅ 沉浸 Ink REPL（app/chat-view/input-bar/status-bar/welcome）+ 斜杠命令（/help /cost /sessions /clear /resume /exit）+ 斜杠补全 picker（↑↓）
- ✅ 流式渲染（自写 markdown 富文本/表格/list）+ 工具折叠（Inline/Block，per-tool 阈值）+ **折叠组延迟冻结**（连续只读工具合并成 tool_group）
- ✅ 键位分工（**Ctrl+C 单击中断/双击退出·Esc 退出弹窗+双击清空**，2026-08-07 二次修订反转 b972f13，详设 docs/20260807000318）+ Ctrl+O pager（less 转录，alternate screen）+ 会话切换（/resume SessionPicker）
- 🟡 **Ctrl+O B+ 精简**（2026-08-06，详设 docs/20260806232155）：format-transcript 按对话分组只留折叠工具（D）+ 进 alternate 前等重绘修双❯（C）+「按 q 退出」提示（G）— 代码完成，**待真机确认**
- ⬜ #40 真机冒烟（D/C/G）+ A 重复文本（streamingText 跨轮累加，待 reducer 日志验证）/ B 乱码（Windows find.exe+GBK）— 另立项

**2026-08-07 夜间产出（用户休息，自主推进，待审核）**：
- ✅ 代码 4 commits：① config 首启自动生成模板+JSON注释兼容（787fad8）② 折叠组延迟冻结—连续只读工具合并摘要（fd56e5a）③ Ctrl+O 转录按对话分组精简+修双❯/退出键/蜂鸣音（8485b08）④ **Esc/Ctrl+C 横向分工**（b972f13，⚠️ breaking）
- ✅ 测试：agent-stream.test.ts 补 maybeCompress 主动压缩端到端触发 + glm-5.2 config 取值（待提交）
- 📄 调研/审查文档（**均未实施，待审核**）：
  - [消息区分设计—光标/loading/对话标识](../功能方案/消息区分设计方案-光标loading对话标识.md)（CC 源码实证：user 整行背景/● 点/▋ 闪烁光标/星号家族 spinner）
  - [Todo 功能方案](../功能方案/Todo功能方案.md)（常驻下方，抄 CC TodoWriteTool 全替换语义）
  - [用户插话机制方案](../功能方案/用户插话机制方案.md)（抄 CC mid-turn drain：运行中排队，工具完成后注入）
  - [M4 权限系统三源交叉验证报告](../里程碑/M4-权限系统三源交叉验证报告.md)（CC/opencode/CCode 对比，建议以 opencode 为模板）
  - [ECode 项目审查报告](../总纲/ECode项目审查报告.md)（3 P0 / 8 🟡 / 7 🟢）
- ⚠️ **3 个 P0（🔴-1/3 已修复 2026-08-07，🔴-2 defer M4）**：
  - 🔴-1 ~~L3 响应式恢复死代码~~（✅ 已修复：agent.ts 内 inner try-catch + forceCompact 重试 + 连续失败熔断，单测绿）
  - 🔴-2 `allow` vs `allow_always` 语义塌陷（agent.ts:379 无条件 add）—— **defer M4**：修复需 UI 提供 allow_once/allow_always 双选项，属 M4 权限系统完整设计
  - 🔴-3 ~~StatusBar Ctx% 累计 token~~（✅ 已修复：reducer latestInputTokens per-call 覆写，app.tsx Ctx% 改用）

**M2 完成**（2026-08-02）：Provider 抽象层落地，agent 解耦 SDK。
- Provider 层（types/transform/claude/openai/config/factory）+ tools 协议中立化 + CLI --model/--list-models
- OpenAI 协议端到端实跑通过（deepseek-chat，含工具调用）

> M2 配置变化：从 M1 的 `ANTHROPIC_AUTH_TOKEN`+Anthropic 兼容端点，改为 config.json 驱动的 `DEEPSEEK_API_KEY`/`ZHIPUAI_API_KEY`（OpenAI 兼容协议，openai SDK）。

## 关键文档

- `docs/总纲/00-开发规划.md` — 总规划与里程碑
- `docs/里程碑/M1-技术选型与理由.md` — 选型决策（ESM / Vitest / tsx / tsconfig）
- `docs/里程碑/M1-实施方案.md` — 骨架记录 + M1 补全清单 + 验收
- `docs/里程碑/M1-方案解析.md` — 协议/SDK 原理 + 设计答疑（合并原 03/04/notes）
- `docs/里程碑/M2-实施方案.md` / `M2-方案解析.md` — Provider 抽象层（接口/翻译/能力探测）
- `docs/调研/借鉴Vercel-AI-SDK对比报告.md` — 11 个借鉴点（Top5 优先级 + 演进路线）
- `docs/里程碑/M3-实施方案.md` / `M3-方案解析.md` — 上下文管理 + Session（5 Phase + 压缩算法）⬜ 待审阅

## 本地参考源码（M3.5 起参照，避免每次联网查）

做交互式 CLI / 权限审批 / CLAUDE.md 兼容等里程碑时，优先参照以下本地源码（源码级可读，不必每次上网查）：

| 项目 | 本地路径 | 参照用途 |
|------|---------|---------|
| CCode（社区对标） | `D:\Study\CCode\cCli` | 同栈(TS+Node)最直接参照：Ink REPL、审批弹窗、CLAUDE.md fallback、AgentLoop 事件流 |
| Claude Code（本尊） | `D:\Study\claude-code-main` | 审批完整规格、自研 Ink fork、partial compact 等设计思想（仅学思想不学规模）。已核查(2026-08-04)：REPL.tsx 5005行 / main.tsx 4683行 / bashPermissions 2621行 均准确；但 Tool.ts 实 792行（文档误称29K）、commands.ts 实 754行（误称25K）——疑字节数误标行数，引用时注意 |
| opencode（SST） | `D:\Study\opencode` | 同 TS 栈、OpenTUI/SolidJS、客户端-服务端分离、Effect-TS |
| OpenClaw | `D:\Study\openclaw` | ⚠️ **非 coding agent**（多渠道个人助手网关），只参考两块特色：① skill 的 `SKILL.md`+frontmatter 格式 + 懒加载注入 + **proposal 审批队列**（skill「自动归纳」实为纯正则、别抄）；② **systemRunPlan 审批守恒**（M4 bash 权限分级时抄，单文件即可）。Gateway/ACP/Canvas/跨设备 pairing 全是过度设计，别碰。详见 [OpenClaw参考研究](../调研/20260806085241_OpenClaw参考研究.md) |
| ECode（本项目） | `D:\Study\ECode` | 自身源码 |

> 路径跨设备可能不同（用户名/盘符），核查时以实际为准。核查文档断言时遵循 [debugging.md #004](./debugging.md)：LLM 既有知识写"具体数值/行号"易失真，必须实读源码核对。

## 环境

- 运行：`npm run dev -- "任务"`（自动加载 `.env`，via `tsx --env-file-if-exists`）
- 默认走 DeepSeek 兼容端点：`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，默认模型 `deepseek-v4-pro`
- 切官方 Claude：改用 `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL=claude-sonnet-4-20250514`，留空 BASE_URL
- Node >= 18（实测 v22.22.2）
