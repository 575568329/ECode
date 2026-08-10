# 技术决策记录

> 跨设备同步（git 跟踪）。记录关键技术选型 / 架构决策及**推翻原因**——尤其推翻既定决策时，必须记下"为什么改"，否则下次会有人（包括 AI）拿旧结论反驳。
> 索引在 [MEMORY.md](./MEMORY.md)。

---

## 决策 #001：M3 Token 计数用 `length/4` 粗估（推翻原 ai-tokenizer 方案）

**日期**：2026-08-03
**状态**：✅ 已决策（用户拍板）
**影响范围**：M3 上下文管理（token 计数 → 压缩阈值判断）；同步修订 `总纲/00-开发规划[进行中].md` / `里程碑/M1-技术选型与理由[已完成].md` / `里程碑/M3-实施方案[已完成].md` / `里程碑/M3-方案解析[已完成].md` / `总纲/里程碑功能流程图[已完成].md`

### 原方案（被推翻）

`00-开发规划[进行中].md` 原定：**ai-tokenizer 为主**做 token 计数，理由是"跨模型统一计数、准确"。

### 新方案

字符串长度 / 4 粗估 token 数，**不引入任何 tokenizer 库**（ai-tokenizer / tiktoken 都不用）：

| 内容类型 | 估算规则 | 理由 |
|---------|---------|------|
| 普通文本 | `length / 4` | 仿 Claude Code 官方 |
| JSON / JSONL | `length / 2` | 结构化文本 token 密度更高 |
| 图像 | 固定 2000 token | 粗略常量 |

中文场景 `length/4` 会**高估**真实 token → 倾向"早压缩" → 容错方向（宁可提前压，别撑爆）。

### 推翻理由（2026-08-03 源码 + Web 核查后）

1. **ai-tokenizer 对 ECode 默认模型不适用**：ai-tokenizer 主打 OpenAI / Anthropic / Google，对 **GLM / DeepSeek 无原生 encoding**（我原写"覆盖 GLM/DeepSeek"是失真记忆，详见 [debugging.md #004](./debugging.md)）。
2. **官方"≥97% 准确率"声明有水分**：仅针对 GPT-5 / Claude / Gemini 等顶级模型；第三方测评（dev.to jerown）对部分模型仅 37.7% within 10%。
3. **Claude Code 官方就是 `length/4`**：`claude-code-main/services/tokenEstimation.ts:203-208`——生产级 agent 都用粗估，说明够用。
4. **压缩阈值只需"趋势"不需精确值**：阈值是"够不够就触发"的判断，±10% 误差不影响决策。
5. **零依赖**：符合"如无必要勿增实体"。

### 备选（留作后续）

Anthropic 侧可选 `count_tokens` API 校准，但 OpenAI-compatible 侧无统一接口、且多一次网络往返。当前两 provider 统一 `length/4`，Anthropic `count_tokens` 留作后续可选优化。

### 关联

- 方法论教训：[debugging.md #004](./debugging.md)（LLM 既有知识写"具体数值"会失真）
- 实施细节：[M3-实施方案[已完成].md](../里程碑/M3-实施方案[已完成].md) 决策 1 / [M3-方案解析[已完成].md](../里程碑/M3-方案解析[已完成].md) §2.2

---

## 决策 #002：Session 同 id = 覆盖（剔除 `-2` 冲突后缀）

**日期**：2026-08-03
**状态**：✅ 已决策（用户拍板：剔除 -2，纯覆盖）
**影响范围**：M3 P4 Session 持久化（`src/session.ts` saveSession + 设计文档 §6.1/§6.9 + 测试）

### 背景

设计文档原定：session 文件名 `${id}_${slug}.json`，**同秒冲突落盘前检测加 `-2`/`-3` 后缀**（§6.1/§6.9）。

### 问题（实施时暴露的内在矛盾）

`saveSession` 收到"同 id 再次落盘"时，无法在内部区分两种场景：
- **续接更新**（§6.5 决策③A）：同一会话 load → 追加新任务 → save，id 相同 → 应**覆盖原文件**（history 连续）。
- **同秒新建冲突**（§6.1）：两个新会话同秒+同 task，id 相同 → 应**加 `-2`**（不丢数据）。

两者输入（同 id、同 slug、文件已存在）完全一样，无外部信号无法区分。且 `-2` 破坏 id 唯一性（`loadSession('id')` 会匹配到两个文件）。

### 新方案

**同 id = 同一会话 = 覆盖**（对齐 Claude Code 纯 id 覆盖语义），不做 `-2`。

### 推翻 `-2` 的理由

1. **与续接覆盖语义矛盾**：saveSession 无法区分续接/新建，`-2` 会破坏 §6.5 决策③A。
2. **`existsSync` 防不了竞态**：两进程并行写，检测都"不存在"→ 都写 → 覆盖；`-2` 只防串行同秒，防不了并行。
3. **场景极罕见**：id 是秒级时间戳，单用户 CLI 同秒+同 task 两个新会话概率极低；即便发生，丢的只是一个刚启动的空会话。
4. **对齐 Claude Code**：CC 用纯 id 命名 `<id>.jsonl`，同 id 天然覆盖，无 `-2`。
5. **YAGNI**：不为极罕见场景增加复杂度。

### 附带实施细化

续接参数从设计文档的 `{ resumedMessages }` 扩展为 `resumed: { id, task, createdAt, messages }`——`task`/`createdAt` 要保持原会话值（§3.4"续接不覆盖首句任务"），runAgent 需这些字段才能正确续写同一文件。不改设计意图（复用 id 续写）。

### 关联

- 实施细节：[M3-实施方案[已完成].md](../里程碑/M3-实施方案[已完成].md) §6.1 / §6.5 / §6.9（已同步修订）
- 代码：[src/session.ts](../../src/session.ts) saveSession / [src/agent.ts](../../src/agent.ts) ResumeContext

---

## 决策 #003：M5 三支点（子代理/MCP/Hooks）核心选型（2026-08-08，设计层，代码未开始）

**日期**：2026-08-08
**状态**：✅ 已决策（设计层锁定；2 处子项 2026-08-09 用户确认：权限继承=A、MCP 配置=A）
**影响范围**：M5 = 支点9 子代理 + 支点10 MCP + 支点12 Hooks。详尽选型/理由见 [M5-技术选型](../里程碑/M5-技术选型与理由[已完成].md)，本条只记核心决策 + 推翻项。

### 锁定的核心决策

| 支点 | 决策 | 关键理由 | 推翻/放弃项 |
|------|------|---------|------------|
| **9 子代理** | **递归 `runAgentStream`**（换 system+tools 子集+空 messages），侦察兵模式（只回最终结论，中间 tool 不外泄） | 复用核心 loop（总纲 4.3 loop 不动）；CC 同构（递归 query）；ECode `runAgentStream(opts)` 天然可重入 | ❌ 独立 session 实体（opencode parentID 式）——子代理可观测归支点 17 |
| **9 权限** | 子代理权限 **⊆ 主代理**，**只能收紧不能放宽** | 防权限代持绕过审批（主派子偷偷改文件） | — |
| **9 防递归** | 深度限制（默认 **1**）+ 子代理默认无 Task 工具 | 取 opencode 保守默认（CC 默认 3 太松） | — |
| **10 协议** | **官方 `@modelcontextprotocol/sdk` v1.30.0**，不自造 | 生态红利（白嫖 CC/Cursor server）；CC/opencode 都用官方 SDK | ❌ 自造协议 |
| **10 原语** | **只做 Tools**，砍 Prompts（归 Skill）/Resources（后置） | YAGNI + 功能收敛 | ❌ HTTP+SSE（规范废弃 2025-03-26）/ DCR（废弃 2026-07-28）/ Sampling·Logging（Deprecated） |
| **10 传输** | 阶段1 stdio → 阶段2 Streamable HTTP+OAuth | 个人 CLI 起步 stdio；远程跟标准 | — |
| **12 形态** | **CC settings.json command hook**（非 opencode TS 插件） | 贴 CC 生态（配置可迁移）；shell 门槛低 | ❌ opencode TS 插件 hook（后置借鉴） |
| **12 事件** | **只做 6 核心**（SessionStart/End + UserPromptSubmit + Pre/PostToolUse + Stop） | YAGNI（CC 30+，80% 是协作/内部） | — |
| **12 安全** | hook 只能收紧不能放宽；系统 hooks 代码注册强制叠加 | 权限 deny 是硬边界，hook allow 翻不了盘（CC 安全核心） | — |

### 🔴 安全红线（M5 三个不可妥协）

1. **子代理权限⊆**：防权限代持（主派子偷偷改文件绕审批）。
2. **MCP stdio RCE 命令 allowlist**：补 opencode 没做的防护（OX Security 2026-04-15 CVE，150M+ downloads 受影响）。
3. **hookSpecificOutput 嵌套**：PreToolUse 结构化决策须嵌套在 `hookSpecificOutput` 下，顶层平铺静默丢弃（CC #48760）。

### ✅ 已确认的 2 处子项（2026-08-09 用户拍板）

| 子项 | 选项 A | 选项 B | 用户决策（2026-08-09） |
|------|--------|--------|----------------------|
| 子代理权限继承 | 继承全部规则（含 allow）✅ 选 | 只继承 deny（opencode 式，allow 子代理自决） | **A**（夜间自动化子代理须带权限跑；权限⊆+deny继承+人设tools收紧保底） |
| MCP 配置存储 | 独立注册表 registry.json（不进 config）✅ 选 | 进 config.json（CC/opencode 式） | **A**（防替换 config 连坐删 MCP；夜间自动化配置稳定） |

### 关联

- 详尽理由 + 放弃方案：[M5-技术选型与理由](../里程碑/M5-技术选型与理由[已完成].md)
- 实施步骤 + 接口/挂点：[M5-实施方案](../里程碑/M5-实施方案[已完成].md)（阶段 0-4）
- 原理答疑：[M5-方案解析](../里程碑/M5-方案解析[已完成].md)
- 核实教训：[debugging.md #015](./debugging.md)（7 处早先假设被联网研究推翻）

---

## 决策 #004：M6 三支点（Skills/模型路由/多渠道）核心选型（2026-08-09，设计层，代码未开始）

**日期**：2026-08-09
**状态**：✅ 已决策（M6 重组 plan 2026-08-09 审阅敲定：D1 一口气全做→v0.2.0、D2 服务化+Web 前端、D3 规则映射、D4 复用 permission-dialog、D7 自动扫；D6 已死——支点14 M5 阶段3 已落地）
**影响范围**：M6 = 支点13 Skills + 支点22 模型路由 + 支点23 多渠道。详尽选型见 [M6-技术选型](../里程碑/M6-技术选型与理由[待实现].md)。

### 锁定的核心决策

| 支点 | 决策 | 关键理由 |
|------|------|---------|
| **13 Skills 格式** | SKILL.md + frontmatter 三家标准（CC/openclaw/opencode） | 零成本跨工具生态兼容 |
| **13 注入** | 懒加载 catalog（name+desc 进 system prompt，触发才读正文） | 防 prompt 爆炸（数量无上限） |
| **13 自动生成** | LLM 归纳（非正则）+ proposal 审批队列 + 安全扫描 + /accept 转正 | OpenClaw 正则假自动是反面；不审批会固化错误流程 |
| **22 路由** | 规则映射（非 LLM 决策） | 路由要省钱，LLM 决策会花掉省的钱 |
| **22 注入** | 四触发点：全局/Skill/子代理循环外注入；压缩轻微侵入 compressOpts | provider/model src/ 现状已有(agent.ts:127/135)，**非 M5 阶段0** |
| **23 多渠道** | 前后端分离 + 本地 HTTP+WS 服务化 + 会话路由 + 鉴权 | 服务化是所有网络渠道公共前提 |
| **23 安全** | 默认 127.0.0.1 + token 鉴权 + 凭证独立 | 不暴露公网（§9.2） |

### 🔑 审阅关键修正（F1-F6，全已修）

最重要：**`provider/model` 注入 src/ 现状已有（M2/M3.5 落地），非 M5 阶段0**——路由层不依赖 M5（仅子代理触发点依赖 M5 子代理）。原稿 6 处错误归属已全改。其余 F2(压缩轻改)/F3(tool_call_start)/F4(session-router 自建锁)/F5(支点14 前置)/F6(安全扫描补回)均已在三文档落地。

### 🟡 待审阅决策（D1-D7）

详见 [M6-审阅决策清单](../里程碑/M6-审阅决策清单[待审阅].md)。**D6**（支点14 注册式重构归 M5 还是 M6）、**D7**（安全扫描方式）是审阅暴露的新点；另需确认前置事实：M5 实施时序、CLAUDE.md §4.2 Web 栈归属（当前 ECode 未装）。

### 关联

- 详尽理由：[M6-技术选型](../里程碑/M6-技术选型与理由[待实现].md)
- 实施步骤：[M6-实施方案](../里程碑/M6-实施方案[待实现].md)
- 原理：[M6-方案解析](../里程碑/M6-方案解析[待实现].md)
- 审阅改定：[M6-文档审阅问题清单](../里程碑/M6-文档审阅问题清单[待审阅].md)

---

## 决策 #005：Repo Map 不进 M6，作为后续扩展功能（扩展化架构）

**日期**：2026-08-09
**状态**：✅ 已决策（用户拍板：不进本期，后续扩展功能做）
**影响范围**：M6 范围界定（Repo Map 拆出）；后续 Repo Map 独立扩展包设计

### 背景

Repo Map 是 aider 标志性创新：tree-sitter 解析符号 → 符号引用图 → PageRank 排序 → 按上下文预算选子集 → 注入 LLM（零 embedding）。M6 重组审阅时用户连续深挖（作用→调研→源码→时效性→维护成本）后定：**不进 M6，后续按扩展功能做**。

### 调研证据（aider 源码级，`D:/Study/aider/aider/repomap.py` 868 行）

本地克隆 aider 源码精读（Explore agent 源码级核实）：
- **机制**：tree-sitter 解析 Tag（def/ref）→ `networkx.pagerank`（personalization 从用户 mention 抽种子；chat 文件 ×50 / mention ×10 / 超常见名 ×0.1）→ 二分搜索 token 预算裁剪（默认 1024，15% 误差早停）→ TreeContext 折叠渲染。
- **时效性（用户最关心）**：**纯 mtime 惰性失效**，无主动文件监听，无 content hash。两层缓存——底层 `TAGS_CACHE`（per-file 解析，磁盘 diskcache 持久，mtime 失效）+ 上层 `map_cache`（整图字符串，内存，cache_key = 文件集 + mention）。git pull 拉新代码 → `get_tracked_files()` 看到新文件 → cache_key 变 → 重算；旧文件 mtime 不变则命中缓存跳过。边角漏洞：同秒写入 / `cp --preserve` / 网络盘 mtime 精度低。
- **map-refresh 四档**（只影响上层 map_cache 命中，底层永远 mtime）：auto（默认）/ always / files / manual。
- **无 git 基本不可用**：文件清单完全依赖 git。
- **依赖一堆原生库**：tree-sitter（Python 原生 binding）+ networkx + diskcache + grep_ast。

### 决策：不进 M6 + 扩展化架构

1. **不进 M6**：全新能力（非收尾）+ 独立里程碑量级重活（868 行 + WASM 化 + 持久化 + PageRank + 折叠渲染），塞进已满载 M6 会拖垮节奏。
2. **扩展化架构**：ECode 核心预留「上下文增强」接入点，Repo Map 作**独立可选 npm 包**（自带 grammar + scm），用户按需安装。核心包不带 tree-sitter WASM（几十 MB 体积消失）、维护解耦、按需付费。
3. **红线适配**（守 §9.3）：tree-sitter → **web-tree-sitter (WASM)**（非原生 binding）；持久化 → **纯 JS 文件存储**（非 better-sqlite3 原生）；PageRank → **graphology**（纯 JS）；scm → **复用 aider 40+ 份**（web-tree-sitter 通用语法）。
4. **时效性比 aider 更稳**（ECode 长驻 agent 优势）：mtime + size + hash 三重失效 + chokidar watch 维护 dirtyFiles + git 信号（`.git/HEAD` 变化）清上层 map_cache。
5. **体积处理**：40+ 语言 grammar（WASM 每个几百 KB~几 MB）不全量内置，起步高频 5-7 门（JS/TS/Python/Go/Rust/Java）+ 缺失优雅降级（该文件不进 map，agent 退回 grep/glob/read）。

### 推翻「进 M6」的理由

- **维护 TCO**：grammar + scm 40+ 语言是长期负担（虽复用上游 tree-sitter 官方 + aider 社区，仍是多一个要版本管理 / 升级 / 测试的子系统）。
- **优先级**：现阶段 npm 发布 / Skills / 路由 / 多渠道更要紧；Repo Map 是锦上添花（aider 靠它吃饭，ECode 卖点是手写 loop + 纯 JS 跨平台）。
- **数据驱动**：开源后用户量起来，有真实数据判断值不值得做。

### 关联

- 调研源码：`D:/Study/aider/aider/repomap.py`（本地参照库，与 CCode / claude-code-main / opencode / openclaw 同列）
- M6 重组 plan：`enchanted-tinkering-coral.md`（范围界定 + 决策记录）
- 红线：CLAUDE.md §9.3（禁原生二进制 → web-tree-sitter WASM）

---

## 决策 #006：子代理 session + runtime-log 隔离到 `_subagents` 子目录

**日期**：2026-08-10
**状态**：✅ 已决策（bug 修复；用户选方案 A 子目录隔离，非"不落盘"）
**影响范围**：M5 子代理（Task 工具）落盘——`src/session.ts` subagentBaseDir + `src/runtime-logger.ts` subagentLogRoot + `src/tools/subagent.ts` 透传

### 背景（bug）

子代理递归 `runAgentStream` 时**没传 `resumed`**（→ 生成新 sessionId）**却透传了主代理的 `sessionBaseDir`/`runtimeLogBaseDir`**（→ 同目录），导致：
- 每派一个子代理，`.ecode/sessions/` 多一个 session 文件，污染 `/resume` 历史列表——违背子代理"黑盒侦察兵"设计（`subagent.ts:7-8` 注释明写只回喂结论文本）。
- 同理 `docs/logs/runtime/` 被子代理 log 淹没。
- 同主会话派多个相似 prompt 子代理 → 一堆 task 相同的"重复"历史对话（用户实锤：一小时多模态调研期间产生 13 个碎片，均嵌在主会话时间窗内）。

### 决策：子目录隔离（方案 A）

子代理落盘到 `<baseDir>/_subagents/`。`listSessions`/`loadSession`/`findFileById` 用 `readdirSync` 非递归 → 子目录天然不扫 → 子代理 session 不进 `/resume` 列表、不可 `--continue` 误加载。runtime-log 同理隔离避免淹没主日志目录。`saveSession` 的 `mkdirSync({recursive})` 自动建子目录。

### 为什么不"彻底不落盘"（方案 B）

1. **保留调试快照**：子代理出问题能查它当时干了啥。
2. **改动最小**：只动透传值，不侵入 `runAgentStream` 核心循环的 11 处 `persistSession`。
3. **与 session 落盘语义一致**：不引入"有时落盘有时不落盘"的条件分支。

### 怎么应用（防再踩）

子代理 / 任何递归 `runAgentStream` 的调用点，`sessionBaseDir` 必须走 `subagentBaseDir()`、`runtimeLogBaseDir` 必须走 `subagentLogRoot()`。新增此类调用点时检查这两行——漏传任一会再次把子代理上下文写进主目录。

### 关联

- 实证方法：runtime-log 的 `logSessionSave` 落盘记录（同主会话时间窗内出现多个不同 id = 子代理碎片）。
- 代码：[src/session.ts](../../src/session.ts) subagentBaseDir / [src/runtime-logger.ts](../../src/runtime-logger.ts) subagentLogRoot / [src/tools/subagent.ts](../../src/tools/subagent.ts)
- 决策 #003（子代理设计：黑盒侦察兵，只回喂结论）

---

## 决策 #007：图片降级不自动切模型——告知 LLM 实际情况让它自己决定

**日期**：2026-08-10
**状态**：✅ 已决策（用户拍板）
**影响范围**：多模态图片输入降级（`src/vision-fallback.ts` + `src/agent.ts`）

### 背景

GLM-5.2 不支持 vision（报 400 `content.type 参数非法`），用户附带图片输入会崩。最初设计了三级降级（inline → switch 自动切模型 → strip），其中 switch 会自动在 config 中查找支持 vision 的模型并切换 model+provider。

### 被推翻的方案：自动切模型（switch 策略）

原 switch 策略：模型不支持 vision → 在 config 中找 vision 模型 → 自动 createProvider + 覆盖 resolvedModel → 后续 agent loop 全程用新模型。

### 推翻理由（用户拍板）

1. **用户选的模型是有意图的**——自动切走会丢上下文/工具能力/费用预期。
2. **不同模型的 system prompt / tools 能力不同**——切换后行为不可控（如 vision 模型可能不支持 tools）。
3. **用户需要时可以自己 `/model` 切换**——不需要 agent 越俎代庖。

### 最终方案：只 strip + 告知 LLM

- 模型支持 vision → inline（直接发 image blocks）
- 模型不支持 → strip（移除图片数据，保留文本路径）+ 注入 `llmHint` 告知 LLM 完整情况
- **LLM 自己看工具列表决定**：调 MCP 图片工具 / 用 bash 处理 / 告诉用户当前环境无法分析

核心原则：**不做代理决策**（不检测 MCP、不自动切模型），只告知 LLM "用户上传了图片但你的模型不支持，路径在文本里"，它自己会找路。

### 关联

- 实现：`src/vision-fallback.ts`、`src/agent.ts`（llmHint 拼入 user message）
- 测试：`tests/vision-fallback.test.ts`（7 单测）
- 踩坑：[debugging.md #020](./debugging.md)（GLM-5.2 不支持 image_url 的 400 错误）

---

## 决策 #008：三个工具失败检测器各司其职（DoomLoop / FailureTracker / errorStreak）

**日期**：2026-08-10
**状态**：✅ 已决策（设计推导，非用户显式拍板但逻辑自洽）
**影响范围**：`src/permission/doom-loop.ts` / `src/tools/failure-tracker.ts`（新）/ `src/agent.ts`（errorStreak 内联）

### 背景

agent loop 中存在三种"工具反复失败"场景，语义不同但容易混淆：

| 场景 | 典型表现 | 正确处理 |
|------|----------|----------|
| LLM 卡在精确重复（同 tool 同 input） | 反复 read 同一文件、反复跑同一命令 | 弹窗询问用户（交还决策权） |
| LLM 变参数连续失败（同 tool 不同 input） | bash 每次换命令变体都报错 | 提醒 LLM 换策略（不禁用工具） |
| MCP 工具连续失败（不可信代码） | zread 瞎编参数反复失败 | 会话内禁用该工具（硬熔断） |

### 决策：三个独立组件，不合并

| 组件 | 检测什么 | 到阈值后 | 适用范围 |
|------|----------|----------|----------|
| `DoomLoopDetector` | 完全相同的 (tool,input) 重复 | 弹窗询问用户 | 防死循环 |
| `ToolFailureTracker` | 任意工具连续 isError（参数可不同） | 提醒 LLM 换策略 | 内置工具试错检测（公共组件） |
| `errorStreak`（agent.ts 内联） | MCP 工具连续 isError | 禁用工具（熔断） | MCP 不可信代码 |

为什么不合并：**语义不同**——DoomLoop 是用户可决策的（弹窗）、FailureTracker 是提醒性的（不禁用）、errorStreak 是硬熔断（禁用）。强行合并会增加条件分支。

### ToolFailureTracker 触发策略

- streak **= 阈值**（3）→ 首次触发
- streak 4~5 → 不重复触发（避免每轮打扰）
- streak **翻倍**（6）→ 再触发一次（第二次提醒）
- 成功一次 → **归零**（偶发失败不累积）

### 关联

- 实现：`src/tools/failure-tracker.ts`（新公共组件）、`src/agent.ts`（接入）
- 测试：`tests/failure-tracker.test.ts`（13 单测）
- 踩坑：[debugging.md #021](./debugging.md)（MAX_ITERATIONS 打满根因之一）
