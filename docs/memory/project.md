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
src/tools/bash.ts      bash 工具独立模块：异步 spawn + Git Bash 探测 + chcp 65001 兜底
                      getShellInfo() 供 system-prompt 注入（Platform/Shell/Cwd）
src/system-prompt.ts  System prompt 拼装（IDENTITY + ENVIRONMENT + BEHAVIOR + TOOL_GUIDE）
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
| M3 上下文压缩 + Session | token 计数、摘要压缩、结果截断、Session 持久化 | 🟡 P1-P4 完成，P5 待（✅ 超限响应式恢复 L3 已接线 2026-08-07）|
| M3.5 交互式 CLI | 沉浸 REPL、slash 命令、流式渲染、中断、富文本/TUI | 🟡 进行中（REPL/斜杠/折叠组/pager/会话切换/**Esc-Ctrl+C 分工**已落地，Ctrl+O B+ 精简代码完成待真机）|
| M4 权限系统 | 三档模式（砍 plan）+ 规则引擎（arity/last wins）+ 路径保护 + 修 🔴-2 + 命令分级 + UI 三态审批 + doom-loop | ✅ 完成 2026-08-08（5 阶段全提交：2e754f4 阶段4 + b60c36b 阶段5；683 单测全绿） |
| M5+ 进阶扩展 | P2: 子代理(9)/MCP(10)/Hooks(12) ｜ P3: Skills(13)/模型路由(22)/多渠道(23) | 🚧 **M5 实施中**：阶段0 地基 + **阶段1 子代理**（76abd74）+ **阶段2 Hooks Pre/Post 引擎**（e7148a4：runner CC 三通道 + inject 多 hook 聚合 + system 强制叠加 + agent Pre/Post 注入零回归，749 测试）；⏸ Hooks settings.json 配置加载/SYSTEM_HOOKS 内容/4 事件流钩子 + 阶段3 MCP 待审阅 |
| M6 远期能力 | Skills(13)+模型路由(22)+多渠道(23) | 📄 **M6 设计完成 2026-08-09**（三文档+审阅改定：6 致命+8 改进全修；D1-D7 待审阅），代码未开始 |

## 当前焦点

**M3 P1-P4 完成**（2026-08-03）：上下文管理 + Session 持久化落地。
- ✅ P1 格式 v2（声明式工具，executor 纯 find+execute 分发，无 switch/case）
- ✅ P2 token 计数（`length/4` 粗估，零依赖，仿 Claude Code）+ 截断（tool_result 内容截断）
- ✅ P3 上下文压缩（maybeCompress 级联：trim tool_result 内容 → summary；trim 保留 tool_use_id 配对不断裂）
- ✅ 超限恢复插队——**L3 响应式已接线**（2026-08-07 修复）：agent.ts 内加 inner try-catch，API 报 context window 超限 → forceCompact 压缩 → 自动重试（含连续失败计数器 + L4 熔断防护）。单测"context window 超限"端到端绿。
- ✅ **P4 Session 持久化**：`src/session.ts`（纯数据层，原子写 tmp+rename，覆盖语义剔除 -2）+ agent loop 挂载（首轮/每轮末/压缩后/结束）+ CLI `--continue`/`-c`/`--resume`/`--sessions`（不带任务=纯恢复不调 LLM）。设计见 [M3-实施方案[已完成].md](../里程碑/M3-实施方案[已完成].md) §6，剔除 -2 决策见 [decisions.md #002](./decisions.md)
- ✅ 151 单测（session 21 + context-resilience 20 + …）；tsc clean
- 🟡 真实 LLM 端到端落盘：待配 `.env` key 实跑（单测 + tsc + CLI 免费分流已验证）
- ⬜ P5 伴随特性（并行只读工具 / retry 读 Retry-After / usage 细化）

**M3.5 交互式 CLI 进行中**（2026-08 起，单测 531 绿）：
- ✅ 沉浸 Ink REPL（app/chat-view/input-bar/status-bar/welcome）+ 斜杠命令（/help /cost /sessions /clear /resume /exit）+ 斜杠补全 picker（↑↓）
- ✅ 流式渲染（自写 markdown 富文本/表格/list）+ 工具折叠（**声明式策略表 FOLD_STRATEGIES**，summary/head/full 三态，不再 per-tool if-else）+ **折叠组延迟冻结**（连续只读工具合并成 tool_group）
- ✅ 键位分工（**Ctrl+C 单击中断/双击退出·Esc 退出弹窗+双击清空**，2026-08-07 二次修订反转 b972f13，详设 docs/20260807000318）+ Ctrl+O pager（less 转录，alternate screen）+ 会话切换（/resume SessionPicker）
- ✅ **Ctrl+O B+ 精简**（2026-08-06，详设 docs/20260806232155）：format-transcript 按对话分组只留折叠工具，`isToolFolded` 读 `foldContent().folded` 单一规则源
- ✅ **bash 跨平台改造**（2026-08-08）：execSync→spawn 异步（治 UI 卡死）+ Git Bash 自动探测（治 find.exe/GBK）+ chcp 65001 兜底 + 超时 120s + system-prompt 注入 Platform/Shell/Cwd
- ✅ **streamingText flush**（2026-08-08）：tool_call_start 轮边界 flush 防跨轮累加重复
- ✅ **foldContent 统一**（2026-08-08）：if-else 链→策略表 + Folded.folded 标志 + isToolFolded 简化 + 新工具一行声明 + 默认 head(3) 兜底
- ✅ **多行输入**（2026-08-08，详设 docs/详设/20260808150000）：ink 7 原生 Kitty 键盘协议（反转 CCode ink 6「拿不到 shift」旧判，详设 §2 有源码证据链），Shift+Enter/Alt+Enter/反斜杠续行 三键全接 + cursorIndex 多行编辑（中间插入/左右/Home/End/上下门控/Backspace 跨行合并）；index.ts render 开 `kittyKeyboard:{mode:'auto'}`。单测 +6 共 537 绿，tsc clean
- ⬜ 真机冒烟：Ctrl+O pager + bash 跨平台 + 消息不重复 + **多行 Shift+Enter（WT）**

**M4 权限系统完成 + M5 设计完成**（2026-08-08，用户休息，自主推进，待审核）：
- ✅ **M4 全 5 阶段提交**（b60c36b）：①path-guard 硬安全网 + check() 三档判定 + 修 🔴-2 ②edit_file dangerous 缺口 ③bash 命令分级（arity 字典归约 + compound 逐段审批，**禁 tree-sitter 用字符串拆分**，§9.3 红线）④settings-loader + CLI flag + Shift+Tab 模式切换 + deny 接线 ⑤体验增强（二次确认 + reject 反馈 + doom-loop 检测 + 危险命令高亮 + UI 三态审批弹窗）。**683 单测全绿**
- ✅ **M4 配置 UX 补全**（2026-08-09）：settings.json 两层首启自动生成带注释模板（user + project，不存在才生成；readSettingsJson 加 `//` strip 复用 config.ts 方式；**模板刻意不含 defaultMode——避免 last wins 下「project 自动生成」覆盖 user 显式选档**）+ 用户指南新增「权限系统」章节（三档/CLI/Shift+Tab/settings.json/规则语法/硬安全网/审批交互）+ 修工具表/里程碑/项目结构过时处。**688 单测全绿**，tsc clean
- 📄 **M5 三文档写完**（设计层，代码未开始）：[技术选型](../里程碑/M5-技术选型与理由[已完成].md) + [实施方案](../里程碑/M5-实施方案[已完成].md) + [方案解析](../里程碑/M5-方案解析[已完成].md)
  - 范围 = 支点9 子代理 + 支点10 MCP + 支点12 Hooks（三 L4 扩展挂载点，复用 runAgentStream 不动核心 loop）
  - **三源联网核实**（2026-08-08）：MCP 规范 `2026-07-28` / SDK v1.30.0 / HTTP+SSE 废弃自 `2025-03-26`（非 2025-11-25）/ DCR 废弃 / CC hooks 30+ 事件 + 5 handler + hookSpecificOutput 嵌套红线 + 权限求值 6 步 / 子代理 frontmatter 17 字段（无 glob）/ 嵌套默认深度 3 / 并发 20 / stdio RCE CVE（OX Security 2026-04-15）
  - 核心设计：子代理=递归 runAgentStream（侦察兵模式只回结论，权限⊆，防递归双保险）；MCP=官方 SDK + 独立注册表 + 只做 Tools + stdio→Streamable HTTP + stdio RCE 命令 allowlist；Hooks=CC settings.json 式（非 opencode TS 插件）+ 6 核心事件 + Pre/Post Promise-await + 系统hooks强制叠加 + hook 只能收紧不能放宽
  - **✅ 两处已确认（2026-08-09 用户）**：①子代理权限继承 = **A（继承全部）**——夜间自动化子代理须带权限跑 ②MCP 配置 = **A（独立注册表）**——防 config 连坐删
  - 角色 agent 审阅**完成**（结果见 [M5-文档审阅问题清单](../里程碑/M5-文档审阅问题清单[已完成].md)）：3 致命（F1 resolveDataDir 待新建/F2 mcp_tool 凭空捏造已删/F3 权限继承悄悄改了已锁定决策）/ 15 改进（多数源码行号精度）。**本轮已修**：F1（阶段0加前置）/F2/I1（deny>ask>allow 无 defer）/I3（**复核 683 正确**，审阅者误数为 542，实测 `vitest run`=683/61 文件全绿）/I4/I6/I7。**已确认（2026-08-09 用户）**：F3=权限继承 **A**（继承全部）/I13=MCP **独立注册**（已去待审阅标）。MCP 规范/SDK/挂点/安全核心经核查**全部成立**。
  - ✅ **测试实测全绿**：`npx vitest run` = **683 passed / 61 文件**（M4 完成态，tsc clean）
- 🐛 踩坑：见 [debugging.md #015](./debugging.md)（M5 三源联网研究推翻 7 处早先假设——HTTP+SSE 废弃日期/DCR 废弃/hook 事件数+handler 种类/hookSpecificOutput 嵌套/子代理 frontmatter 字段/嵌套深度，"不要瞎想"的实证教训）

**M6 远期能力设计完成**（2026-08-09，用户休息，自主推进，待审核）：
- 📄 **M6 三文档写完 + 审阅改定**（设计层，代码未开始）：[技术选型](../里程碑/M6-技术选型与理由[待实现].md) + [实施方案](../里程碑/M6-实施方案[待实现].md) + [方案解析](../里程碑/M6-方案解析[待实现].md)
  - 范围 = 支点13 Skills + 支点22 模型路由 + 支点23 多渠道（P3 远期，复用主干道不动核心 loop）
  - 核心设计：Skills=SKILL.md 三家标准+懒加载 catalog+proposal 审批(安全扫描+/accept)；路由=规则映射(非 LLM)+四触发点(全局/Skill/子代理循环外注入，压缩轻微侵入 compressOpts)；多渠道=前后端分离+本地 HTTP+WS 服务化+会话路由+鉴权(默认 127.0.0.1)
  - 🔑 **审阅关键修正**：F1 `provider/model` 注入 src/ 现状已有(M2/M3.5)，**非 M5 阶段0**(M5 阶段0 只加 tools)→ 路由层不依赖 M5；F2 压缩触发点轻微侵入 compressOpts(非"循环零改")；F3 WS tool_call→tool_call_start；F4 session.ts 无状态无 resume，session-router 自建映射+锁；F5 支点14 注册式重构是斜杠命令前置；F6 安全扫描补回
  - **🟡 D1-D7 待用户审阅**（[决策清单](../里程碑/M6-审阅决策清单[待审阅].md)）：D1 范围 ｜ D2 多渠道形态 ｜ D3 路由方式 ｜ D4 审批 UI ｜ D5 IM 平台 ｜ **D6**(审阅新增)支点14 归属 ｜ **D7**(审阅新增)安全扫描方式

**2026-08-07 夜间产出（用户休息，自主推进，待审核）**：
- ✅ 代码 4 commits：① config 首启自动生成模板+JSON注释兼容（787fad8）② 折叠组延迟冻结—连续只读工具合并摘要（fd56e5a）③ Ctrl+O 转录按对话分组精简+修双❯/退出键/蜂鸣音（8485b08）④ **Esc/Ctrl+C 横向分工**（b972f13，⚠️ breaking）
- ✅ 测试：agent-stream.test.ts 补 maybeCompress 主动压缩端到端触发 + glm-5.2 config 取值（待提交）
- 📄 调研/审查文档（**均未实施，待审核**）：
  - [消息区分设计—光标/loading/对话标识](../功能方案/消息区分设计方案-光标loading对话标识.md)（CC 源码实证：user 整行背景/● 点/▋ 闪烁光标/星号家族 spinner）
  - [Todo 功能方案](../功能方案/Todo功能方案.md)（常驻下方，抄 CC TodoWriteTool 全替换语义）
  - [用户插话机制方案](../功能方案/用户插话机制方案.md)（抄 CC mid-turn drain：运行中排队，工具完成后注入）
  - [M4 权限系统三源交叉验证报告](../里程碑/M4-权限系统三源交叉验证报告.md)（CC/opencode/CCode 对比，建议以 opencode 为模板）
  - [ECode 项目审查报告](../总纲/ECode项目审查报告.md)（3 P0 / 8 🟡 / 7 🟢）
- ⚠️ **3 个 P0（🔴-1/2/3 全部已修复 2026-08-08）**：
  - 🔴-1 ~~L3 响应式恢复死代码~~（✅ 已修复：agent.ts 内 inner try-catch + forceCompact 重试 + 连续失败熔断，单测绿）
  - 🔴-2 ~~`allow` vs `allow_always` 语义塌陷~~（✅ 已修复 2026-08-08 M4 阶段 2）：gate 升级返回三态（allow_once/allow_always/deny），核心层仅 allow_always 时 `allow.add`，UI 透传三态不再 add；check-integration + use-agent-stream 双层回归单测绿
  - 🔴-3 ~~StatusBar Ctx% 累计 token~~（✅ 已修复：reducer latestInputTokens per-call 覆写，app.tsx Ctx% 改用）

**M2 完成**（2026-08-02）：Provider 抽象层落地，agent 解耦 SDK。
- Provider 层（types/transform/claude/openai/config/factory）+ tools 协议中立化 + CLI --model/--list-models
- OpenAI 协议端到端实跑通过（deepseek-chat，含工具调用）

> M2 配置变化：从 M1 的 `ANTHROPIC_AUTH_TOKEN`+Anthropic 兼容端点，改为 config.json 驱动的 `DEEPSEEK_API_KEY`/`ZHIPUAI_API_KEY`（OpenAI 兼容协议，openai SDK）。

## 关键文档

- `docs/总纲/00-开发规划[进行中].md` — 总规划与里程碑
- `docs/里程碑/M1-技术选型与理由[已完成].md` — 选型决策（ESM / Vitest / tsx / tsconfig）
- `docs/里程碑/M1-实施方案[已完成].md` — 骨架记录 + M1 补全清单 + 验收
- `docs/里程碑/M1-方案解析[已完成].md` — 协议/SDK 原理 + 设计答疑（合并原 03/04/notes）
- `docs/里程碑/M2-实施方案[已完成].md` / `M2-方案解析[已完成].md` — Provider 抽象层（接口/翻译/能力探测）
- `docs/调研/借鉴Vercel-AI-SDK对比报告.md` — 11 个借鉴点（Top5 优先级 + 演进路线）
- `docs/里程碑/M3-实施方案[已完成].md` / `M3-方案解析[已完成].md` — 上下文管理 + Session（5 Phase + 压缩算法）⬜ 待审阅

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
