---
layer: n/a
status: stable
---

# Agent 成本优化 ECode 对照与差距清单

## 1. 问题陈述与方法

拿外部文章《Agent 终章（Harness 成本篇）》的成本框架（少发 / 发得便宜 / 少想 / Subagent / Hook / 模型分流）给 ECode 做一次逐项体检，回答两个问题：

1. 文章的哪些做法 ECode **已经同款实现**（确认既有资产，避免重复建设）；
2. 哪些是**真实差距**，按杠杆/成本比排序，供里程碑排期参考。

**核查方法**：2026-08-21，基于 `feat/m1-heart` 分支（提交 9eaecc2，M12-B2 之后），三路独立源码核查（system prompt 与缓存链路 / 工具与 Skill 加载 / Subagent 与压缩与模型选择），"有/没有"结论均有文件行号实证，不凭记忆——**唯一例外**：§5 thinking 一行初判为"无控制"，系核查搜索词局限（只搜了 summaryModel/cheapModel 类变量名，漏查 thinking 配置键），三角色审阅核码纠偏后已修正（见 §7 审阅记录）。文章原文提取见姊妹篇 [2026-08-21_Agent成本优化实战文章精华提取_已完成.md](./2026-08-21_Agent成本优化实战文章精华提取_已完成.md)（章节号 §n 与该篇对应）。

**总评**：ECode 在架构思想上多处与文章推荐正解同款甚至更精细（system 分段化、子代理结论回传、CC 式工具定义），但文章的两把主杠杆——"少发"与"发得便宜"——ECode 基本未启用；ECode 现有的解法是第三把杠杆（事后压缩），也是三把中最贵的一把。度量链路有四维成本底座，缺命中率视角。

## 2. 总对照表

| 文章维度 | ECode 现状 | 判定 |
|---|---|---|
| §1 token 去向认知 | 有认知（M5 压缩立项依据），解法靠事后压缩；无压缩时全量历史重发 | ⚠️ 解法单一 |
| §2 度量 | usage 四维采集+计价+展示链路在（注：OpenAI 口径有已知 bug——`prompt_tokens` 含 cached 未减，M12 §5.1 已排修复，本文对照结论以修复后为准，`src/providers/openai.ts:73`）；无命中率、无外部观测/评测闭环 | ⚠️ 半个 |
| §3.1 删教学文本 | 静态前缀克制（身份+cwd+platform+工具指引） | ✅ |
| §3.2 system 每轮重建 | 每轮重建走请求 system 字段，历史只存对话 | ✅ 同款 |
| §3.3 工具 schema 按需加载 | MCP"按需"仅连接延迟；schema 每轮全量携带 | ❌ |
| §3.4 工具标准化 | 命名对齐 CC + 扁平 schema + 描述精简 + MCP schema 归一化 | ✅ 同款 |
| §3.5 skill 全文去重 | 有 Level 0/1/2 渐进披露；重复触发重复注入全文 | ⚠️ 半个 |
| §3.6 重复 read 去重 | 无，每次真实读盘 | ❌ |
| §3.7 MCP→CLI | 内置生态天然 CLI 派；但重 MCP 场景无防线 | ⚠️ 方向暗合 |
| §4.1 system 分层 | M8 S5 分段化同款思想（静态前缀+动态后缀固定序+预算） | ✅ 同款 |
| §4.2 cache_control 打标 | 全仓库零处，纯依赖端点隐式缓存；四维统计底座已在 | ❌ **最大差距** |
| §5 thinking 控制 | 四档 thinking 配置已有（off/low/medium/high→budget_tokens，M4-D9）；压缩等辅助调用天然不带 thinking（=文章"关 thinking"已是现状）；缺的只是按角色用便宜模型 | ⚠️ 半个 |
| §6 Subagent | 结论回传+16KB 截断+transcript 落盘+任务书五要素，重合度最高 | ✅ 基本同款 |
| §7 无效轮次拦截 | 仅 empty_tool_use 一处防护；无复读/同参/连续空错检测 | ❌ |
| §8 模型分流 | 多 provider 配置+手动切换有；全链路单模型 | ❌ |

## 3. 逐项对照详述

### 3.1 §3"少发"七招

**已同款的两招**：

- **system 每轮重建（§3.2）**：`buildSystemPrompt()` 每轮 startTurn 时重建（`src/host/session.ts:242`），Anthropic 走 API `system` 字段（`src/providers/anthropic.ts:245`）；OpenAI 侧正是文章点名的"原生不支持 system 字段、靠框架处理"场景，ECode 的做法（每轮拼装为 messages 首条、历史数组只存 user/assistant，`src/providers/openai.ts:144`）即文章正解——system 永远 ×1。
- **工具标准化（§3.4）**：内置工具命名对齐 CC（read_file/write_file/edit_file/bash/grep/glob/ls），全扁平 JSON Schema（`src/tools/interface.ts:51`），描述 30-120 字符量级；MCP 工具 schema 注册前还强制归一化（剥 $defs/$ref、oneOf/anyOf 丢弃、properties ≤64、深度 ≤8，`src/services/mcp/adapt.ts:144`），比文章做得还多一层。

**不等价的一项（§3.3）**：ECode M6 的"MCP 按需加载"是**连接级**延迟（lazy 无缓存时启动 bootstrap 连一次拿清单、随后按空闲策略断开不保活；metadata cache 命中则零连接注册，`src/services/mcp/manager.ts:141,158-173`），不是 schema 级延迟——启动时全部工具 schema 已注册进 ToolRegistry，每轮 `specs()` 全量携带（`src/core/loop.ts:168`、`src/tools/registry.ts:54`）。文章的常驻池/延迟池/目录+reveal 机制 ECode 没有。

**缺失的两小招（§3.5/§3.6）**：`Skill` 工具每次调用无条件返回全文 `<skill_content>`（`src/tools/builtin/skill.ts:27`），无"已加载"检查、无短回执——渐进披露有（Level 0 清单进 system / Level 1 正文按需 / Level 2 附属文件 read_file），单份不变式没有。read_file 无 mtime 已读集合（`src/tools/builtin/read_file.ts:34`），同轮重复读同文件每次都真读真进历史。

**方向暗合的一项（§3.7）**：ECode 内置生态本来就是 CLI 派（bash 常驻+工具精简），没踩过文章 MongoDB MCP 24 工具那种坑；但防线缺失意味着一旦用户配置多个重 MCP server，§3.3 的差距会让账单立刻显形。

### 3.2 §4"发得便宜"

**分层（§4.1）——已同款**：M8 S5 分段化正是文章按稳定性分层控制爆炸半径的思想：静态前缀（身份+cwd+platform+工具选择指引）永不变，动态段按 指令→记忆→skill→路由 固定序拼接，注释原话"动态内容变化不击穿前缀的 prompt cache"（`src/core/system.ts:6` 文件头注释；结构见 `22-66`）；skill 清单有 token 预算防膨胀；**ECode 不注入时间戳**，天然规避了文章点名的最典型易变内容。未做到的细节：动态区无逐块字符预算（文章限 4k/块、16k 总量）、tools 列表无"先固定排序再截断"的显式纪律（实际由 Map 注册序保证，MCP 重连覆盖注册时风险低但存在）。

**打标（§4.2）——最大差距**：全仓库零处 `cache_control`/`ephemeral`，命中完全依赖端点隐式自动缓存——按文章实测，隐式意味着不可预期且可能出现整轮归零。而底座已经齐了：`src/services/pricing.ts` 就是 cache 四维成本拆分（input/output/cacheRead×0.1/cacheCreation×1.25），两个 Provider 都在采集 `cache_read_input_tokens`/`cached_tokens`（`anthropic.ts:82`、`openai.ts:71`）——**等于油表装好了却没踩油门**。在 `@anthropic-ai/sdk` 请求的末条消息加 `cache_control` 是几个字段的事（落点须在投影合并后的请求尾部，即 `anthropic.ts:206-218` 同 role 合并之后）；GLM Astron 端点对显式标记的支持幅度需实测，且"对比打标前后"要求先有落盘基线——现状 usage 事件只 publish 给内存订阅者、LogStore/history 零处持久化（M12 §5.3 会话累计落盘为待做项），故正确顺序是**统计落盘先行、打标随后**（§4 #1）。

### 3.3 §5"少想"

ECode **已有请求参数级 thinking 控制**（初版对照误判为"无"，系核查搜索词局限，审阅核码纠偏，见 §7）：config 四档 `thinking`（off/low/medium/high，`src/services/config.ts:29,113`）映射为 Anthropic 协议 `thinking.budget_tokens`（2048/8192/16384，`src/providers/anthropic.ts:19-26`，M4-D9 已定型 GLM/Anthropic 兼容端点格式）并逐请求注入（`anthropic.ts:240-246`）——文章 §5.2"给思考设预算上限"ECode 已具备（档位全局固定、不可逐调用调，粒度粗于文章的逐场景扫描拐点）。文章 §5.1"辅助调用关 thinking"也已是现状：压缩摘要的 `callSummary` 构造请求不含 thinking 字段（`src/services/compaction/summarize.ts:201-210`，Anthropic 协议下=未开思考），只是模型仍用会话旗舰（`summarize.ts:205`）。**真实差距只剩文章 §8 的角色分流**：无"按角色引用便宜模型"的配置指针，压缩摘要这类"输入长输出短、答案空间窄"的调用在用旗舰模型。

### 3.4 §6 Subagent——重合度最高的一节

M11 与文章几乎逐条对上：

| 文章要求 | ECode 实现 | 证据 |
|---|---|---|
| 只回传结论+路径 | 回传最后一条 assistant 文本 + transcript 路径提示，16KB 截断 | `src/services/subagent.ts:36,244-263,312` |
| 完整过程落文件（冷存储） | transcript 独立落 `~/.ecode/agents/<agentId>.jsonl`（0700，异常/中断也落） | `subagent.ts:321-339` |
| 任务书六要素 | description 要求"目标与原因/涉及文件/验收标准/期望返回格式/写码还是只调研/并行碰不同文件"——覆盖五要素 | `subagent.ts:272-286` |
| 独立上下文防炸主 | 独立压缩链（CompactionOrchestrator+SummarizeStrategy） | `subagent.ts:197-198` |

三个小差距：①回传上限 16KB 比文章的 600 字符宽松一个数量级以上（约 10-30 倍，口径为字节 vs 字符；ECode 取舍：编码场景结论常带代码片段，宽松合理，但可考虑引导子代理"结论摘要+细节留 transcript"）；②**超时/中断无强制自总结**——文章用 hook 注入一轮总结把已花 token 变现，ECode 直接报错或取已有最后文本（`subagent.ts:298-320`）；③主代理无"按路径复核 transcript"的引导（可以用 bash cat，但 description 没提）。文章 6.1 的完整派发规则表（适合拆/留下四条）ECode 只覆盖部分，未注入 system prompt。

### 3.5 §7 无效轮次拦截——基本空白

loop 唯一沾边的是 `empty_tool_use` 防护（声称调工具没给工具则跳过，`src/core/loop.ts:346`）。复读检测、跨 Turn 指纹、同参工具检测、连续空错检测、审批无人响应检测全无。已有两个熔断器**域不同但机制同款**：

- QualityGate：连续 2 次失败且输出 sha256 无变化即熔断（`src/services/quality.ts:19,126`）——正是文章 §7.2 的指纹思路，但只管 lint/test 回喂闭环；
- 压缩链：连续 3 次失败熔断（`src/services/compaction/orchestrator.ts:31`）。

两点使这节对 ECode 相关度高于表面：其一，ECode 跑 GLM，复读/纯 reasoning 无正文正是文章记录的国产模型高发退化模式；其二，文章"用户连续 3 次未响应审批就停"对刚落地的 M12-B2 ApprovalBroker 挂起式审批有直接参考价值——多端场景用户不在场时不能无限挂起，需要超时策略（该超时属 ApprovalBroker 分策略表层，不在下文 #2 的 loop 检测范围）。

**落点**：检测器放宿主层而非 loop——`afterTools` 回调（`src/core/loop.ts:97`，已带本轮工具名+isError、可返回 feedback 回喂）承载"连续空错提醒"，`PostToolUse` hook（带 tool_input）承载同参检测，SSE 复读可在宿主流消费方检测并经宿主持有的 AbortSignal 断流。唯一可能需要心脏配合的是"空回答不进历史"的丢弃语义（messages 归 loop 持有，hook 只能注入不能丢弃）——若确需须单列心脏扩展决策，不得裹进检测计数器（M12 §11.4 硬门：loop.ts 被迫修改视为批次设计错误）。

### 3.6 §8 模型分流

多 provider 配置 + `/model` 手动切换有（`src/services/config.ts:37`），但主循环/子代理/压缩摘要全链路同一个模型，无角色指针。ECode 是本地 CLI 不需要文章那套 gRPC 下发，但配置层加一个 `summaryModel` 类角色指针完全可行（providers map 已具备多模型能力，缺的只是"按角色引用"而非"全局 current"）。最大受益者是 M5 map-reduce 压缩：多批并行、输入长输出短，正是 classify 型调用。

## 4. 差距清单（按杠杆/成本比排序）

> **框定**：下表是**机会清单而非缺陷清单**，各项均未列入任何里程碑；#1 的取舍以前置验证结果为准。防误读说明见 §5.1。

**前置验证（阻塞 #1，约半天，任何排期入口的第一步）**：GLM Astron 端点对 `cache_control` 的支持幅度——打标请求，观察响应 cache 字段与计费变化。对照组数据现成：OpenAI 协议侧一直在采 `cached_tokens`（`src/providers/openai.ts:71-76`），可先读 2-3 个真实会话得出**当前隐式命中率**——若隐式命中已稳定偏高，显式打标边际收益有限，#1 降级顺延、#2 顶上（读数受已知口径 bug 影响，见 §2 度量行注）。

| # | 差距 | 杠杆 | 成本 | 说明 |
|---|---|---|---|---|
| 1 | **cache_control 显式打标** | 高（待前置验证） | 小（粗估） | Provider 出口加字段，落点在投影合并后的请求尾部；**排在 M12 token 统计批之后做独立小批，统计先行**（理由见下方被否决备选）。「命中率展示」（cacheRead/input 比率）则可随统计批搭车 |
| 2 | **无效轮次检测**（复读指纹/同参工具/连续空错 + 熔断） | 中高 | 中（粗估） | 落点宿主层而非 loop（afterTools feedback + PostToolUse 同参检测 + 宿主流消费方复读断流，详见 §3.5 落点段）；QualityGate 已有同款指纹+熔断先例；GLM 上复读风险真实存在 |
| 3 | Skill 重复注入去重 | 中 | 小 | `Skill` 工具加"已加载"检查，重复调用回一行短回执；激活集合从历史推导（重启一致，且 /rewind·/clear 恢复一致性免费——与 M11 todo"消息即状态免 Store"同款理由）。会话级状态落 ctx.session 窄接口（M12-B4 已落地、B8.2 已接 confirm/子代理进度，`src/tools/interface.ts`），"从历史推导"还需补 messages 通路（D5 扩展）；不放模块级单例（B4 正在拆除该形态） |
| 4 | 重复 read 去重 | 中 | 小 | mtime 已读集合（read_file schema 仅 path 无部分读参数，path+mtime 键控安全），同轮重复读返回"文件未变"；状态可直接挂 ctx.session（通路已落地，扩展一个字段即可） |
| 5 | 辅助调用模型分流 | 中 | 小（粗估） | thinking 开关与预算已有、辅助调用已天然不带 thinking（§3.3），剩"按角色引用便宜模型"的配置指针（providers map 已具备多模型能力，缺角色指针而非全局 current）。排位靠后原因：压缩触发频率远低于每轮请求，且换模型有压缩质量风险，宜在 #3/#4 后做 |
| 6 | 子代理超时强制自总结 | 低中 | 小 | subagent.ts 服务层超时分支（:298-320）注入一轮总结，把已烧的探索 token 变成可回传结论；排位低因只在超时场景触发，收益面窄 |
| 7 | MCP schema 延迟加载（常驻池/延迟池） | 低（当前） | 高 | 缓做但登记复评触发器：① 把"固定前缀 token 量（system+tools.specs()）"纳入 M12 /stats（顺手，且让"收益不显"可证伪）；② 复评条件——单会话 MCP schema 固定开销占比过高，或 plugin 携带 MCP 进场（M7 `.ecode-plugin/` 可带 mcpServers，重 schema 可能经市场静默进场，"等用户显式配置"的观察信号会失灵） |

**两个被否决的备选**（按解析目录论证要求记录）：

- **#1 时机"并入 M12 token 统计批"——被否决**。三重理由：其一，M12 §11 批注明写 token 统计 P0 并行窗口尚未启动，不存在可搭车的在跑批次；其二，统计批六项全是度量/存储/展示，打标是请求路径行为变更（改真实计费行为），塞入改变批次性质且污染正在建立的度量基线；其三，"对比打标前后"这一验证方法本身要求先有打标前统计，与"并入同批"自相矛盾。正解：**统计先行、打标随后**。
- **#2 落点"loop 层三个计数器"——被否决**。撞"心脏零改动"铁律（AGENTS 2.6 + M12 §11.4 硬门：loop.ts 被迫修改视为批次设计错误）；现有缝隙（afterTools / PostToolUse / 宿主流消费方）足以承载复读、同参、连续空错三类检测，无须动心脏。

优先级依据：#1 是唯一"底座已齐只缺临门一脚"的高杠杆项（但杠杆大小系于前置验证，验证不过则降级）；#2-#4 实现小、收益随会话长度线性放大；#5/#6 各有压后理由（触发频率/收益面）；#7 明确缓做（YAGNI + 触发器复评）。成本列均为粗估，排期前需按人天细化。

**M12 接线状态**：本文建议**尚未写入** M12 方案（单向引用）。实施 M12 §5 token 统计时需人工带回两点：#1 的"统计先行、打标随后"顺序，以及 #7 的"固定前缀 token 量进 /stats"。

## 5. 反驳：这份对照什么情况下不成立

1. **场景差异削弱紧迫性**：文章是生产级诊断 agent（30-40 轮、多 subagent、无人值守），ECode 是交互式编码 CLI，轮次密度和计费敏感度低一档——"没做"不等于"欠债"，清单是机会清单不是缺陷清单；
2. **端点行为未验证**：GLM Astron 兼容端点对 cache_control 的支持幅度未实测（#1 实现前必须先探针验证，避免打标被端点静默忽略的空转）；thinking 参数语义已由 M4-D9 定型（§3.3），不在未验证之列；
3. **计费模型不同**：文章数字基于百炼（显式 ×10%/隐式 ×20%），GLM 的缓存计价结构不同，88% 不可平移，实际收益要靠 #1 落地后的命中率数据说话；
4. **16KB 回传上限未必是差距**：编码场景子代理结论常含代码片段，文章 600 字符的截断是为诊断报告场景定的，ECode 的宽松取舍有其场景合理性。

## 6. 证据索引（核查快照）

> 证据仅对基线提交 **9eaecc2** 负责，代码演进后**不回改本文**，复核请 checkout 基线。已知漂移：`src/host/session.ts` 的 buildSystemPrompt 调用在 B3（4cf964d）后移至约 line 300。
>
> **2026-08-22 全量复核**（HEAD c3ee954，主对话亲自逐条读源码，非 subagent）：全部机制性断言在最新代码依然成立——thinking 三处（`config.ts:29,113,257,305`、`anthropic.ts:20-26,33-36,240`、`summarize.ts:201-210` 不含 thinking）、`cache_control`/`ephemeral` 全 src/ 零命中、system.ts 无时间戳注入、usage 仍只 publish 未落盘（`session.ts:140-141,411-418`，LogStore/history 零持久化）、subagent 回传/16KB/超时/transcript 机制不变、skill 全文返回无去重、read_file 无 mtime 检查、QualityGate/压缩熔断阈值不变。行号漂移（机制不变）：subagent.ts 关键段 +12~+36（:36 RESULT_MAX_BYTES 未动，lastAssistantText :257、clampResult :271、超时 :325/:341、任务书 :284-298）、`tools/interface.ts:51→70`（B4 插入 ctx.session）、`loop.ts:346→348`、`quality.ts:19→20`。**新发现**：B4/B8.2 已落地 `ctx.session` 窄接口（tasks/updateSubagent/confirmTool/askUser），#4 落点可直接扩展、#3 需补 messages 通路——§4 已同步。

- system prompt 组装：`src/core/system.ts:22-66`、`src/host/session.ts:242-246`、`src/providers/anthropic.ts:245`、`src/providers/openai.ts:144`
- 缓存与成本：`src/services/pricing.ts:1-113`（四维、缺省比例 23-24）、`src/providers/anthropic.ts:82-96,140-143`、`src/providers/openai.ts:26,71-76`；`cache_control`/`ephemeral` 全仓库零命中
- 历史投影：`src/core/context.ts:42-71`、`src/services/compaction/hook.ts:47-83`、`src/core/loop.ts:263-274`、`src/providers/anthropic.ts:206-218`（同 role 合并）
- MCP 加载：`src/services/mcp/manager.ts:5,141-185,320-331`、`src/services/mcp/setup.ts:64-67`、`src/services/mcp/adapt.ts:144-173`、`src/core/loop.ts:168`、`src/tools/registry.ts:54-60`
- Skill：`src/services/skill.ts:6-7,203,349-352`、`src/tools/builtin/skill.ts:14-57`、`src/core/system.ts:53-64`（清单）
- read_file：`src/tools/builtin/read_file.ts:34-67`（无去重）
- Subagent：`src/services/subagent.ts:36,197-198,244-263,272-286,298-320,321-339`
- 压缩：`src/services/compaction/summarize.ts:129-197,200-217`、`src/services/compaction/strategy.ts:29-30`、`src/services/compaction/orchestrator.ts:31`
- 拦截与熔断：`src/core/loop.ts:346-350`（empty_tool_use）、`src/services/quality.ts:19-20,96-139`、`src/services/compaction/orchestrator.ts:31`
- 模型配置：`src/services/config.ts:37-38`、`src/providers/interface.ts:44-55`（无角色分流）
- thinking 控制（审阅补验）：`src/services/config.ts:29,113,257,305`、`src/providers/anthropic.ts:19-26,240-246`、`src/services/compaction/summarize.ts:201-210`

## 7. 审阅记录（2026-08-21，三角色）

架构师 / 资深开发（事实核查）/ 产品经理 三角色独立审阅，共 **1 P0 + 13 P1 + 14 P2**，全部当日修复：

- **P0×1（三方两人命中）**：§5 thinking"ECode 无请求参数控制"与源码相反——M4-D9 起即有四档 thinking→budget_tokens 控制（2048/8192/16384），压缩等辅助调用构造请求天然不带 thinking（=文章"关 thinking"已是现状）。根因是初版核查搜索词局限（只搜 summaryModel/cheapModel 类变量名，漏查 thinking 配置键）。§2 表/§3.3/§4#5/§5 已改，§1 方法声明补例外坦白。
- **P1×13**：#1"可并入 M12 统计批"不成立（时机/范围/基线三重理由）→ 改"统计先行、打标随后"+独立小批+被否决备选；#2"loop 层计数器"撞心脏零改动铁律 → 改宿主层缝隙落点+单列决策预留；system.ts 注释引文非原话 → 改原话并标 `:6`；"lazy 首调才连"引滞后头注释 → 改为实际 bootstrap 行为；提取篇 §10 混入提取者推断 → 删对比句+节首标注；16KB"两个数量级"夸大 → 改"一个数量级以上（约 10-30 倍）"；#1 杠杆"高"建立在对家数据上且 ECode 侧零采样 → 改"高（待前置验证）"+前置验证小节+降级路径；两条端点前置散落三处 → 聚合为 §4 前置验证；"已有 usage 日志"不实（只 publish 未落盘）→ 改"统计落盘先行"；OpenAI usage 口径 bug 与 M12 §5.1 结论分叉 → §2 补注；"可并入"系单向引用 M12 零处提及 → 补接线状态说明；差距表在前定性在后易被误读为需求清单 → §4 加框定语；"缺实测采样" → 前置验证含隐式命中率采样法。
- **P2×14**：#5/#6 补排位理由；#7 补度量（固定前缀占比进 /stats）+复评触发器（plugin 静默带 MCP 通道）；#3/#4 会话级状态落点对齐 M12-D5+补 rewind 免费论证；补被否决备选两条；README 索引新表被空行切断渲染碎 → 修复；提取篇"部落中间"笔误、"20 次/20 轮"不统一、延迟池漏列 AppSkill、"全文粘贴件存档"无出处；对照篇描述区间 30-80→30-120；成本列标注粗估；§6 加"证据仅对基线负责"声明+已知漂移注。

三份审阅原报（含逐条证据）存当日会话记录。本文此后作为排期参考以本修订版为准。

**2026-08-22 追加：主对话亲自复核**（不再经 subagent——P0 教训后对修订版全部断言逐条读源码验证）：基线后代码又前进 4 笔提交（至 c3ee954，含 M12-B3/B4/B8/B9 与审阅修复批），全部机制性断言在最新代码依然成立、零翻车（含 thinking 修正三处、cache_control 零命中、usage 未落盘、subagent 四项机制）；行号漂移明细与新发现的 ctx.session 通路已记入 §6 复核注并同步 §4 #3/#4 落点。

**→ 六项差距的落地方案见 [M13 成本优化实施方案](../详设/2026-08-22_后续-M13-成本优化实施方案_待审核.md)（2026-08-22，待审核）。**
