# ECode 设计文档

> Agent loop 为心脏，其余能力为分支往上搭建。

这是 docs 目录的**唯一索引和约定中心**。子目录不再有各自的 README。

## 这套文档怎么读

文档按**读者意图**分 6 个目录，不按模块分。原因：模块会随设计演进重组，而「我想知道这是什么 / 怎么实现的 / 为什么这么设计 / 出问题了怎么办 / 决定了什么 / 契约长什么样」这六种意图是稳定的。

| 目录 | 回答什么 | 读者 |
|---|---|---|
| [大纲/](./大纲) | **是什么**。顶层鸟瞰、概念地图、模块边界 | 所有人 |
| [详设/](./详设) | **怎么实现**。每个子系统的数据结构、流程、接口、错误处理 | 实现者 |
| [解析/](./解析) | **为什么这么做**。理论拆解、方案对比、决策论证 | 设计者 / 评审 |
| [诊断/](./诊断) | **出问题怎么办**。故障排查路径、常见坑、调试手段 | 使用者 / 维护者 |
| [决策/](./决策) | **决定过什么**。ADR（架构决策记录），有时序、不可变、只追加 | 所有人 |
| [规范/](./规范) | **契约长什么样**。对外接口、数据格式、协议 | 集成方 / 实现者 |

## 已落地文档

| 文档 | 位置 | 说明 |
|---|---|---|
| ECode MVP 详设 v6 | [详设/2026-08-11_ECode-MVP详设_待审核.md](./详设/2026-08-11_ECode-MVP详设_待审核.md) | 权威总览，已并入评审修订 + 日志系统 + 技术栈细化 + 配置系统与多 Provider + TUI 设计规范 |
| MVP 详设评审报告 | [解析/2026-08-11_MVP详设评审报告_待审核.md](./解析/2026-08-11_MVP详设评审报告_待审核.md) | 5 阻塞 + 9 重要 + 缺失项，对应 ADR-008 起 |
| MVP 技术栈选型解析 | [解析/2026-08-11_MVP-技术栈选型解析_待审核.md](./解析/2026-08-11_MVP-技术栈选型解析_待审核.md) | ESM/TUI/grep/ls/glob/bash/JSON Schema 方案对比，对应 ADR-015 起 |
| MVP 配置系统与多 Provider 解析 | [解析/2026-08-11_MVP-配置系统与多Provider解析_待审核.md](./解析/2026-08-11_MVP-配置系统与多Provider解析_待审核.md) | 配置分层/JSONC/两层 Provider/两协议/跨 provider 切换，对应 ADR-021 起 |
| MVP TUI 设计规范 | [规范/2026-08-11_MVP-TUI设计规范_已完成.md](./规范/2026-08-11_MVP-TUI设计规范_已完成.md) | 全屏框架式 + 品牌启动屏 + 适度色彩：界面原型/视觉/键盘/交互流程/组件规格，实现者 |
| MVP Provider 翻译层与心脏数据流解析 | [解析/2026-08-12_MVP-Provider翻译层与心脏数据流解析_待审核.md](./解析/2026-08-12_MVP-Provider翻译层与心脏数据流解析_待审核.md) | 端到端数据流脑图 / SSE 事件→Delta 翻译 / Translator 状态机 / usage 守卫覆盖（官方 SDK+Vercel+LangChain 三库对比）/ CLI 调用链（makeDeps·runOnce·runLoop）/ 两层循环 / 工具来源扩展性（为什么 loop 不会膨胀） |
| MVP 终端 Markdown 渲染调研 | [解析/2026-08-13_MVP-终端Markdown渲染调研_已完成.md](./解析/2026-08-13_MVP-终端Markdown渲染调研_已完成.md) | 自建渲染器 vs 主流对标（marked-terminal/claude-code/codex/aider/opencode）；流式 markdown 四路线选型；OSC8/CJK/代码高亮；落地借鉴清单 |
| TUI 渲染方案：最小 Static | [详设/2026-08-13_ECode-TUI渲染架构_最小Static详设_已完成.md](./详设/2026-08-13_ECode-TUI渲染架构_最小Static详设_已完成.md) | M2 去 Static 后满屏/顺序两大问题根治；Static（历史固化）+ 当前轮动态可展开；用户定配置（流式 3 / 工具合并 4 / 下一轮收起）；满屏 clearTerminal 代码级证据；OpenTUI 长期观望 |
| M3 工具与确认实施方案 | [详设/2026-08-13_M3-工具与确认实施方案_已完成.md](./详设/2026-08-13_M3-工具与确认实施方案_已完成.md) | 5 工具（ls/glob/grep/write_file/edit_file）schema + bash 安全（截断/拦截）+ ConfirmPrompt（diff 确认）+ .ecodeignore；D1-D7 决策拍板；小切片策略（只读先发） |
| M4 持久化与配置实施方案 | [详设/2026-08-13_M4-持久化与配置实施方案_待审核.md](./详设/2026-08-13_M4-持久化与配置实施方案_待审核.md) | HistoryStore 真存储 + /history /model 命令 + 配置完整（采样参数）+ OpenaiProvider + 首次向导；D1-D7 拍板；MVP 收官 |
| 后续 M5 实施方案 | [详设/2026-08-14_后续-M5实施方案_已完成.md](./详设/2026-08-14_后续-M5实施方案_已完成.md) | 上下文压缩 v10（架构定型）**★已实施 P0-P10**（493/493+tsc零）：插件化策略骨架（CompactionStrategy+registry+编排器）+ **单策略 summarize**（切分/不变量/滚动/降级）+ 投影分离（messagesRef全量+buildContextMessages投影，loop不mutate）+ models.dev contextWindow（★GLM-4.6/5=204800）+ cache四维成本+/compact /cost+切换model检测；Skill/MCP→M6 |
| 后续 M6 实施方案 | [详设/2026-08-14_后续-M6实施方案_已完成.md](./详设/2026-08-14_后续-M6实施方案_已完成.md) | **★已实施（202a769，636/636+tsc 零+真机 smoke；§16 实施记录）** v6（Plugin 拆出 M7，M6 聚焦 Skill+MCP）——Skill 三层渐进式加载 + **双触发面**（LLM SkillTool + `/skill args` 手动 `$ARGUMENTS` 传参，双布尔独立开关）+ token 预算 + 蒸馏 L2（创建+升级合并协议）；MCP 官方 SDK + **按需加载**（lazy 默认+metadata cache+六态状态机+failed 60s 过期退避+空闲卸载）+ 默认确认 + 首用批准 + **M4.6 全链路走读**（MCP 工具=借来的 Tool：注册线差异收在两端 / 调用线与内置工具同构零分支 / 字段对照表）；**面板 TUI（v5）**：PanelShell 基础设施（复用 overlay 挂载+viewState 多级导航+Esc 逐级回退+窗口滚动+即时搜索）+ SkillPanel（分组列表+Enter 回填选用）+ McpPanel（列表→详情→工具三级+重连/断开乐观更新+failed 错误展开）+ 统一键位规范；全文第一人称，参考来源集中附录 B；心脏零改动 |
| 后续 M7 HookRunner+Plugin 实施方案（已完成）| [详设/2026-08-14_后续-M7-Plugin实施方案_已完成.md](./详设/2026-08-14_后续-M7-Plugin实施方案_已完成.md) | **★已实施（76a521c/0822aeb/44b4076 + 审阅修复 acdce7a + gracefulShutdown/fflate 4cc1e2d + 真机反馈修复 R6：HookRunner 双源六事件 + PluginLoader 安装链/版本 cache/卸载 + PluginPanel 三页签 + 退出优雅关闭 + zip 硬化）**——第一部分 HookRunner：双源模型（用户 config hooks 键 ↔ 扩展注册表仅删除注销才移除）+ 事件最小 6 个（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd）+ command 执行体（mcp_tool 不做）+ 装饰 Registry 接入（loop 零改动）；第二部分 Plugin：marketplace + 版本 cache + 清单 + 资源接入四件套（`.ecode-plugin/` 贴 Claude 生态兼容，skills+mcpServers 可直接消费官方 marketplace）+ `/plugin` 三页签面板（浏览/搜索/详情/安装/添加市场）+ 安全四件套（官方名预留/路径净化/sha 校验/占位符白名单）；PluginLoader 显式拿 Registry 引用（M7-D6，ADR-026 维持暂缓） |
| 后续 M8 实施方案 | [详设/2026-08-15_后续-M8实施方案_已完成.md](./详设/2026-08-15_后续-M8实施方案_已完成.md) | **★已实施（2026-08-16 全量 P0-P5 + 方案外交付，852/852；文末实施记录）**：交互与上下文智能——ECODE.md/CLAUDE.md 两级注入（ECODE.md 为主+CLAUDE.md 兼容回退；findUp 首个+32KB 守卫）/ ask_user 选项框（1-4问×2-4选+Other UI 追加+防滥用三支柱+argv 非交互守卫）/ auto-memory（MEMORY.md 索引+topic 文件零新基建）/ WebFetch（SSRF 私网拦截）/ system prompt 分段化 / M5 债 #6#2 清账；全里程碑心脏零改动 |
| 后续 M9 实施方案 | [详设/2026-08-15_后续-M9实施方案_待启动.md](./详设/2026-08-15_后续-M9实施方案_待启动.md) | **设计稿 v1.1（待启动，排在 M8 后）**：改动安全网与质量闭环——**hooks 接线缺口修复 P0**（SessionStart context 消费/signal 透传/stop_reason 等 4 项）/ checkpoint 文件快照+`/rewind`（rewind_to 投影标记与 boundary 同机制）/ 编辑后 lint/test 自动回喂（探测 package.json+连续失败熔断）/ git 轻量集成（autoCommit 默认关+trailer 标记 /undo 只退自己的）/ 沙箱四档**默认关**（软沙箱+bash 诚实声明；full-access 总放行档：内置黑名单+用户可配 blockedCommands 硬拒，对标 CC bypass deny 仍强制）/ **权限系统首步 Hook(owner) 三态**（M8 §11 储备前移）/ LSP 占位；**附录 D 后置需求观察区**（未排期裁剪 31 项，触发器登记簿）；M8-D12 流式 markdown 彻底放弃 |
| 后续 M10 实施方案 | [详设/2026-08-16_后续-M10实施方案_待启动.md](./详设/2026-08-16_后续-M10实施方案_待启动.md) | **设计稿 v1.1（待启动，排在 M9 后；2026-08-16 用户拍板立项+同日调研修订）**：感知扩展与配置可视化——多模态输入 ImageBlock（**ToolResult.blocks 扩展**+magic bytes 判定+双协议翻译含 **OpenAI 侧 image 转移**/5MB+8000px 守卫/压缩历史不存 base64/非 V 模型守卫）/ WebSearch（**智谱 HTTP 规格已核实**：/api/paas/v4/web_search 同 key 体系，engine 默认 std ¥0.01/次，domain+recency 参数，25s 超时）/ /config 应用内面板（三页签+搜索模式优先+**jsonc modify 非破坏保存**+Providers 页只读降级+$EDITOR 逃生口） |
| M10 感知扩展与配置面板调研 | [解析/2026-08-16_M10感知扩展与配置面板调研_已完成.md](./解析/2026-08-16_M10感知扩展与配置面板调研_已完成.md) | 三家一手实现（CC 三平台粘贴/magic bytes/缩放链/tool_result 数组 image/服务端 WebSearch/四 Tab 设置面板；opencode photon WASM/Exa MCP 搜索；codex remote URL 拒绝）+ 官方规格（Anthropic 5MB·8000px·1568·(w×h)/750；智谱搜索全字段+错误码；GLM-4.6V 128K/Flash 免费）+ **v1→v1.1 修订对照 11 条**（ToolResult 扩展前置/缩放链否决 sharp·photon/engine 默认 std/Providers 页降级） |
| 上下文压缩调研 | [解析/2026-08-14_上下文压缩调研_已完成.md](./解析/2026-08-14_上下文压缩调研_已完成.md) | Claude 官方 Context Engineering 三原语（Tool Clearing/Compaction/Memory）+ claude-code 阈值演进（90%→64-75% land the plane）+ 各家迭代摘要；M5 压缩设计依据 |
| 上下文压缩源码调研 | [解析/2026-08-14_上下文压缩源码调研_已完成.md](./解析/2026-08-14_上下文压缩源码调研_已完成.md) | claude-code 多级管线+9段prompt+不变量保护 / opencode select切分+滚动summary（最干净可抄）/ aider 递归+第一人称prompt / codex 三策略+hooks；四家对比+ECode 组合借鉴；M5 压缩算法最终依据 |
| M5 上下文压缩问答解析 | [解析/2026-08-14_后续-M5上下文压缩问答解析_待审核.md](./解析/2026-08-14_后续-M5上下文压缩问答解析_待审核.md) | 一轮连续追问整理：投影分离心智模型 / 触发判定两层 / boundary 位置性跳过 / append-only+滚动锚定 / 手动自动对照 / 分批 map-reduce（含序列化为什么不影响理解、bytes/4 教训、真机 800k 并行 58s）/ 决策浓缩表 |
| M9 安全网与质量闭环解析（新手向） | [解析/2026-08-16_后续-M9安全网与质量闭环解析_已完成.md](./解析/2026-08-16_后续-M9安全网与质量闭环解析_已完成.md) | 四道防线全景 / checkpoint content-addressed（写前基线·治理三线·近修改集兜底）/ **/rewind 心脏**：文件真改 vs 对话只加标记（三层分离表）/ tool_use id 借用锚 / 区间闭合（锚消息→标记行）/ 撤销回退=缺锚全量的正确语义（补锚=半截状态反例）/ quality 熔断 / git 三层保护（trailer·--only·reset --soft 各自的坑）/ 沙箱四档+权限三态三层 / 终审 9 项 7 落地 2 虚报勘误 + 四项新修复 / 新手 FAQ（真实问答沉淀） |
| 双协议出入参规范 | [规范/2026-08-15_双协议出入参规范_待审核.md](./规范/2026-08-15_双协议出入参规范_待审核.md) | Anthropic Messages + OpenAI Chat Completions 全出入参（★必填/⚠格式标注）；messages 结构铁律与 chunk 全表；§3 双协议详细对比（必填差异/system 位置/content 形态/工具包裹/寻址/usage 位置/ECode 翻译层对照/共同坑清单） |
| history/context 分离 + memory 调研 | [解析/2026-08-14_history与context分离及memory调研_已完成.md](./解析/2026-08-14_history与context分离及memory调研_已完成.md) | ★ opencode 投影模型（filterCompacted，恢复不触发压缩）/ claude-code boundary 截断 / codex replacement_history 快照 / aider 反例（恢复即压缩=ECode原缺陷）；memory：四家 AGENTS.md 注入 + system prompt 分段 + subagent fork；ECode AGENTS.md runtime 未读（最浪费） |
| ECode 自测方法 | [规范/2026-08-14_ECode自测方法_已完成.md](./规范/2026-08-14_ECode自测方法_已完成.md) | Agent 完全自测体系（5 层）：单测 / ink-testing 渲染 / node 脚本真模块 / argv / **node-pty 真 TUI**（pty 提供 TTY 让 Ink raw mode 工作，管道 stdin 不行；★ 分开写输入+回车避 TextInput 时序坑）|
| ECode 活文档清单与同步守则 | [规范/2026-08-16_活文档清单与同步守则_已完成.md](./规范/2026-08-16_活文档清单与同步守则_已完成.md) | 17 处活文档（运行时提示词/用户模板/人读文档）清单 + 同步触发表；防漂移测试 + /doctor 抽查 + 清单人查三层防线 |
| M5 真机测试单 | [诊断/2026-08-14_M5真机测试单_已完成.md](./诊断/2026-08-14_M5真机测试单_已完成.md) | T1-T9 case（压缩触发/命令/数据完整性），含 P0 修复验证重点 + 失败速查表 |
| ADR-026 AppContext 与 Plugin 装配骨架 | [决策/2026-08-14_ADR-026-引入AppContext与Plugin装配骨架_已完成.md](./决策/2026-08-14_ADR-026-引入AppContext与Plugin装配骨架_已完成.md) | 借鉴 deepseek-harness（Cordis Plugin 形状 + capability seam 三角色）统一装配；**暂缓采纳**——M5 后 makeDeps 未膨胀（22 行）、M6 PluginLoader 需求未验证；M6 实施到装配环节若确需再开新 ADR supersedes；源码引用已验证准确 |
| M7 Hooks 与 Plugin 执行链解析 | [解析/2026-08-15_后续-M7-Hooks与Plugin执行链解析_待审核.md](./解析/2026-08-15_后续-M7-Hooks与Plugin执行链解析_待审核.md) | 一轮连续代码走读整理：三分离模型（声明分散/触发分散/执行集中）/ 三源注册与 specsFor 归一（拉模型）/ makeDeps 只插线 / 七案发现场+装饰器 / dispatch→runOne→runCommandHook 逐跳 / handler 五字段消费点 / verdict 对账表 / fail-open 落点 / 黑名单 / mcp_tool 占位≠MCP 不可用 / plugin 安装链+loadOne 四类分发 / 高频误区速查 + 接线缺口（→M9 附录D.5） |

> 其余文档按需在各目录补充，命名见下方约定。

## 范围划分：MVP 内 vs MVP 后

文档**不按子目录分 MVP/后续**（避免目录过深），而是**从文件名中间标识**：

- MVP 范围文档：中文名称以 `MVP-` 开头或含 `MVP` 字样，如 `2026-08-11_MVP-代理循环详设_待启动.md`、`2026-08-11_ECode-MVP详设_待审核.md`。
- MVP 后文档：中文名称以 `后续-` 开头，如 `2026-08-11_后续-MCP客户端详设_待启动.md`。

MVP 的范围与非目标，以 [ECode MVP 详设](./详设/2026-08-11_ECode-MVP详设_待审核.md) 的 0.4 节为准。**别把文件名带 `后续-` 的文档当成现在要做的事。**

## 概念模型：三层架构

ECode 的架构只有三块（详见 MVP 详设第 1 节）：

```
              ┌──────────────────────────────────────┐
              │            AgentLoop（心脏）          │
              │   反复调 LLM → 执行工具 → 回喂，       │
              │   直到 LLM 不再要求工具                │
              └────────┬──────────────────────┬───────┘
                       │                      │
        ┌──────────────▼──────────┐  ┌────────▼──────────────┐
        │ LLMProvider Registry    │  │ Tool Registry         │
        │ (可插拔分支面·模型接入) │  │ (可插拔分支面·工具能力)│
        │ • AnthropicProvider     │  │ • read/write/edit/    │
        │   → 接 GLM/Astron       │  │   glob/grep/bash      │
        │ • (预留 OpenAI 等)      │  │ • (预留 MCP 动态注册) │
        └─────────────────────────┘  └───────────────────────┘

   ┌──────── 内置分层服务（直接接入心脏，不走 Registry，YAGNI）────────┐
   │ Config · HistoryStore · LogStore · CommandRegistry · Logger ·    │
   │ Permissions                                                      │
   └──────────────────────────────────────────────────────────────────┘
```

**三句话**：
1. **心脏**只做一件事：循环调 LLM、执行工具、把结果塞回 messages。它不认识任何具体的工具或模型。
2. **两个 Registry** 是可插拔的扩展面——加工具/加模型 = 写实现 + `register()`，心脏零改动。
3. **内置服务**走分层直接接入，不套接口（YAGNI）。

**唯一铁律**：心脏（AgentLoop）永远不出现 `if provider === 'xxx'` 这类判断——所有协议差异封在 Provider 实现内部。

### 文档归属标注（frontmatter 的 layer 字段）

| layer | 含义 |
|---|---|
| `core` | 心脏（AgentLoop、规范模型、错误处理） |
| `provider` | LLMProvider 分支面 |
| `tool` | Tool 分支面 |
| `service` | 内置分层服务（Config/History/LogStore/Command/Logger/Permissions） |
| `tui` | TUI 分支 |
| `n/a` | 跨层/不属于任何一块（如总览、术语、评审报告） |

## 命名约定

### 目录名
中文：`大纲 / 详设 / 解析 / 诊断 / 决策 / 规范`。不再分 MVP/后续 子目录，范围靠文件名中间标识（见上"范围划分"）。**只有顶层一份 README**，子目录不放 README。

### 文档文件名
**全中文优先**，格式：

```
YYYY-MM-DD_[MVP-|后续-]中文名称_状态.md
```

- **时间码** = 创建日期（`YYYY-MM-DD`），一旦确定**不再改动**。
- **范围标识**（可选）：`MVP-` 或 `后续-`，紧跟时间码后、中文名称前。MVP 范围文档用 `MVP-`（或名称本身含 MVP，如 `ECode-MVP详设`）。
- **中文名称** = 文档主题，简短，不带日期/状态/范围。
- **状态** = 从固定枚举里取一个（见下）。

示例：
```
2026-08-11_ECode-MVP详设_待审核.md
2026-08-11_MVP-代理循环详设_待启动.md
2026-08-11_MVP详设评审报告_待审核.md
2026-08-11_后续-MCP客户端详设_待启动.md
2026-08-11_ADR-001-选用ReAct循环_待审核.md
```

### 状态枚举（固定，不可自造）

| 状态 | 含义 |
|---|---|
| `待启动` | 已立项，还没动笔 |
| `进行中` | 正在写 |
| `待审核` | 写完等评审 |
| `已完成` | 评审通过，定稿 |
| `已废弃` | 被取代或失效，保留原文不删 |

> **状态变更 = 重命名文件**。改状态时同步更新顶层 README 的"已落地文档"表（若该文档在其中）。时间码始终保持不变。

### ADR 编号
ADR 文件名里含编号：`2026-08-11_ADR-001-选用ReAct循环_待审核.md`，编号三位递增。一条决策一个文件，只追加不修改；要改就开新 ADR 标记 `supersedes`，保留原文。

## 文档写作规范

### 通用 frontmatter
每篇文档顶部必须有 frontmatter：

```yaml
---
layer: core | provider | tool | service | tui | n/a
status: draft | review | stable
---
```

`status` 字段与文件名状态保持一致。

### 各目录的内容侧重与写作原则

| 目录 | 应写什么 | 写作原则要点 |
|---|---|---|
| **大纲/** | 总览、架构图、术语、模块地图、用户旅程、非目标 | 只讲"是什么"和"边界"，不讲实现（详设的事）不讲为什么（解析的事）；多用图少用长段落 |
| **详设/** | 每个子系统的职责/数据结构/流程/接口/错误处理/开放问题 | 每篇只写一个子系统、可独立读懂；必须有状态图或时序图；接口用代码块不用散文；标 `depends_on`；**MVP 总览是权威**，冲突以总览为准 |
| **解析/** | 理论拆解、方案对比、决策论证、外部对标 | 必须给出**被否决的备选**否则不算论证；结论要可证伪（写明什么情况下选错）；引用外部给链接 |
| **诊断/** | 症状→可能原因→验证步骤→修复→预防 | 每个症状必须配可执行的验证步骤（看哪个日志/跑哪个命令），不能停在"可能是 xxx"；修复步骤可复制粘贴；区分设计缺陷（回流详设/开 ADR）和使用错误 |
| **决策/** | ADR：背景/决策/理由/后果/备选 | 结论先行（Decision 一句话）；**必须写后果的代价**不只写好处；不回头改，改就开新 ADR |
| **规范/** | 配置 schema、协议契约、接口规范、命令清单 | 必须可被独立实现（不依赖读详设）；用 Schema/接口定义不用散文；标 `stability`；每个字段标"是否敏感" |

### 详设模板（最常用）
```markdown
---
layer: core | provider | tool | service | tui
status: draft | review | stable
depends_on: [其他设计文档]
---

# 子系统名

## 职责    一句话 + 不做什么
## 数据结构  类型定义 / schema
## 流程     状态图 / 时序图 + 关键步骤说明
## 接口     对外暴露什么
## 错误处理  失败模式 + 恢复策略
## 开放问题  尚未决定的点
```

### 解析模板
```markdown
---
layer: core | provider | tool | service | tui | n/a
status: draft | review | stable
related_adr: [ADR-xxx]
---

# 主题

## 问题陈述  要决策什么、为什么需要决策
## 备选方案  至少 2 个，列出各自的优缺点
## 论证     对比、引用、数据、推演
## 结论     选了哪个，为什么（结论若被采纳，去 决策/ 开 ADR）
## 反驳     这个选择最大的风险是什么、什么情况下会反悔
```

### ADR 模板
```markdown
---
id: ADR-NNN
title: 决策标题
status: proposed | accepted | superseded | deprecated
date: YYYY-MM-DD
supersedes: []
related_analysis: []
---

# ADR-NNN: 决策标题

## 背景 (Context)   为什么现在要做这个决策
## 决策 (Decision)  一句话核心结论
## 理由 (Rationale) 凭什么这么选，链接到 解析/
## 后果 (Consequences) 正面/负面/风险
## 备选 (Alternatives considered) 被否决的方案 + 为什么
```
