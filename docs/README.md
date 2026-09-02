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
| MVP TUI 设计规范 | [规范/2026-08-11_MVP-TUI设计规范_已完成.md](./规范/2026-08-11_MVP-TUI设计规范_已完成.md) | 全屏框架式 + 品牌启动屏 + 适度色彩：界面原型/视觉/键盘/交互流程/组件规格；§3.3 栅格铁律（图标槽/内容列/面分类/禁止事项）2026-08-30 成文，实现者 |
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
| 后续 M10 实施方案 | [详设/2026-08-16_后续-M10实施方案_已完成.md](./详设/2026-08-16_后续-M10实施方案_已完成.md) | **已完成（v1.9 经核码审阅；2026-08-17 实施 1007/1007，文末实施记录）**：多模态 ImageBlock+PDF（blocks 附着+magic bytes+双协议翻译 OpenAI 侧 image 转移+守卫+触点全改）/ 图片粘贴（Alt+V+附件持久目录+history image_ref 双向转换）/ WebSearch 免费优先三层（cn.bing RSS 默认/DDG 放弃/智谱可选+SearchFuse）/ /config 三页签面板（jsonc 非破坏+.bak+损坏防护）/ 后台任务（TaskRegistry+run_in_background+task_output·stop+双时点通知+杀树复用 v1.3 先行落地） |
| M10 感知扩展与配置面板调研 | [解析/2026-08-16_M10感知扩展与配置面板调研_已完成.md](./解析/2026-08-16_M10感知扩展与配置面板调研_已完成.md) | 三家一手实现（CC 三平台粘贴/magic bytes/缩放链/tool_result 数组 image/服务端 WebSearch/四 Tab 设置面板；opencode photon WASM/Exa MCP 搜索；codex remote URL 拒绝）+ 官方规格（Anthropic 5MB·8000px·1568·(w×h)/750；智谱搜索全字段+错误码；GLM-4.6V 128K/Flash 免费）+ **v1→v1.1 修订对照 11 条**（ToolResult 扩展前置/缩放链否决 sharp·photon/engine 默认 std/Providers 页降级） |
| 图片能力处理调研 | [解析/2026-08-29_图片能力处理调研_已完成.md](./解析/2026-08-29_图片能力处理调研_已完成.md) | 拆视觉名门（78873ab）后 P1 处置：四家源码实证（aider 静默丢图/codex Image poisoning/opencode 请求时 ERROR 替换/CC 扣留+剥图重试——唯一自动恢复）+ 两条一手实证（models.dev 元数据正确、智谱端点文本模型收图不 400）+ 拍板（warn 出路指引做/自动剥图挂账/元数据预检否决） |
| 上下文压缩调研 | [解析/2026-08-14_上下文压缩调研_已完成.md](./解析/2026-08-14_上下文压缩调研_已完成.md) | Claude 官方 Context Engineering 三原语（Tool Clearing/Compaction/Memory）+ claude-code 阈值演进（90%→64-75% land the plane）+ 各家迭代摘要；M5 压缩设计依据 |
| 上下文压缩源码调研 | [解析/2026-08-14_上下文压缩源码调研_已完成.md](./解析/2026-08-14_上下文压缩源码调研_已完成.md) | claude-code 多级管线+9段prompt+不变量保护 / opencode select切分+滚动summary（最干净可抄）/ aider 递归+第一人称prompt / codex 三策略+hooks；四家对比+ECode 组合借鉴；M5 压缩算法最终依据 |
| M5 上下文压缩问答解析 | [解析/2026-08-14_后续-M5上下文压缩问答解析_待审核.md](./解析/2026-08-14_后续-M5上下文压缩问答解析_待审核.md) | 一轮连续追问整理：投影分离心智模型 / 触发判定两层 / boundary 位置性跳过 / append-only+滚动锚定 / 手动自动对照 / 分批 map-reduce（含序列化为什么不影响理解、bytes/4 教训、真机 800k 并行 58s）/ 决策浓缩表 |
| R 线配对与远程接入功能解析 | [解析/2026-09-01_R线配对与远程接入功能解析_已完成.md](./解析/2026-09-01_R线配对与远程接入功能解析_已完成.md) | **新手向功能全景**：快递柜比喻三角色/四关键决策（扫码发钥匙·中继是瞎子·每设备独立卡·代次防复活）/一条消息的旅程/技术一句话表/四场景交互流程/安全威胁对照/代码地图/六层验证/FAQ；配套自部署指南与审阅报告 |
| M9 安全网与质量闭环解析（新手向） | [解析/2026-08-16_后续-M9安全网与质量闭环解析_已完成.md](./解析/2026-08-16_后续-M9安全网与质量闭环解析_已完成.md) | 四道防线全景 / checkpoint content-addressed（写前基线·治理三线·近修改集兜底）/ **/rewind 心脏**：文件真改 vs 对话只加标记（三层分离表）/ tool_use id 借用锚 / 区间闭合（锚消息→标记行）/ 撤销回退=缺锚全量的正确语义（补锚=半截状态反例）/ quality 熔断 / git 三层保护（trailer·--only·reset --soft 各自的坑）/ 沙箱四档+权限三态三层 / 终审 9 项 7 落地 2 虚报勘误 + 四项新修复 / 新手 FAQ（真实问答沉淀） |
| 双协议出入参规范 | [规范/2026-08-15_双协议出入参规范_待审核.md](./规范/2026-08-15_双协议出入参规范_待审核.md) | Anthropic Messages + OpenAI Chat Completions 全出入参（★必填/⚠格式标注）；messages 结构铁律与 chunk 全表；§3 双协议详细对比（必填差异/system 位置/content 形态/工具包裹/寻址/usage 位置/ECode 翻译层对照/共同坑清单） |
| history/context 分离 + memory 调研 | [解析/2026-08-14_history与context分离及memory调研_已完成.md](./解析/2026-08-14_history与context分离及memory调研_已完成.md) | ★ opencode 投影模型（filterCompacted，恢复不触发压缩）/ claude-code boundary 截断 / codex replacement_history 快照 / aider 反例（恢复即压缩=ECode原缺陷）；memory：四家 AGENTS.md 注入 + system prompt 分段 + subagent fork；ECode AGENTS.md runtime 未读（最浪费） |
| ECode 自测方法 | [规范/2026-08-14_ECode自测方法_已完成.md](./规范/2026-08-14_ECode自测方法_已完成.md) | Agent 完全自测体系（5 层）：单测 / ink-testing 渲染 / node 脚本真模块 / argv / **node-pty 真 TUI**（pty 提供 TTY 让 Ink raw mode 工作，管道 stdin 不行；★ 分开写输入+回车避 TextInput 时序坑）|
| ECode 活文档清单与同步守则 | [规范/2026-08-16_活文档清单与同步守则_已完成.md](./规范/2026-08-16_活文档清单与同步守则_已完成.md) | 17 处活文档（运行时提示词/用户模板/人读文档）清单 + 同步触发表；防漂移测试 + /doctor 抽查 + 清单人查三层防线 |
| M5 真机测试单 | [诊断/2026-08-14_M5真机测试单_已完成.md](./诊断/2026-08-14_M5真机测试单_已完成.md) | T1-T9 case（压缩触发/命令/数据完整性），含 P0 修复验证重点 + 失败速查表 |
| ADR-026 AppContext 与 Plugin 装配骨架 | [决策/2026-08-14_ADR-026-引入AppContext与Plugin装配骨架_已完成.md](./决策/2026-08-14_ADR-026-引入AppContext与Plugin装配骨架_已完成.md) | 借鉴 deepseek-harness（Cordis Plugin 形状 + capability seam 三角色）统一装配；**暂缓采纳**——M5 后 makeDeps 未膨胀（22 行）、M6 PluginLoader 需求未验证；M6 实施到装配环节若确需再开新 ADR supersedes；源码引用已验证准确 |
| M7 Hooks 与 Plugin 执行链解析 | [解析/2026-08-15_后续-M7-Hooks与Plugin执行链解析_待审核.md](./解析/2026-08-15_后续-M7-Hooks与Plugin执行链解析_待审核.md) | 一轮连续代码走读整理：三分离模型（声明分散/触发分散/执行集中）/ 三源注册与 specsFor 归一（拉模型）/ makeDeps 只插线 / 七案发现场+装饰器 / dispatch→runOne→runCommandHook 逐跳 / handler 五字段消费点 / verdict 对账表 / fail-open 落点 / 黑名单 / mcp_tool 占位≠MCP 不可用 / plugin 安装链+loadOne 四类分发 / 高频误区速查 + 接线缺口（→M9 附录D.5） |
| M11 Subagent 实施方案 | [详设/2026-08-17_后续-M11-Subagent实施方案_已完成.md](./详设/2026-08-17_后续-M11-Subagent实施方案_已完成.md) | task 工具内嵌 runLoop（心脏零改动）/并发直上（readonly 并行池无硬上限+竞态三防线）/禁配 task+ask_user+todo（v1.2：清单主权归主 agent）/transcript 独立/log agentId 隔离/UI 高度预算/顺带修 stop 谎报/todo 任务清单工具（v1.2 扩入：全量替换+消息即状态免 Store+transcript 内联渲染）/主循环插话（v1.3 扩入：忙碌态排队+双时点投递（pollUserInput 步间注入+轮末兜底）+Ctrl+C 不弃队列）；M11-D1~D26 全决策 |
| Subagent 机制调研 | [解析/2026-08-17_Subagent机制调研_已完成.md](./解析/2026-08-17_Subagent机制调研_已完成.md) | 立项前一手源码调研（CC/opencode）：调用纪律=description 反例教学非硬限制（业界防错用不防多用、鼓励并发）/ 唯一共同硬限制=递归一层封顶（CC 工具过滤 vs opencode 深度+权限派生）/ 两层提示词模板（主侧反"委派理解"+子侧返回契约）/ UI=折叠一行+进度流+高度自适应降级 / S1-S7 立项决策清单 + ECode 复用面映射 |
| M12 服务化与多端调研 | [解析/2026-08-18_M12服务化与多端调研_已完成.md](./解析/2026-08-18_M12服务化与多端调研_已完成.md) | token 统计三家对照（CC stats-cache 按天增量缓存/opencode SQLite 会话行六字段+tiers 分级定价/harness 投影 fold 无成本——ECode 取 CC 模式：内存累计+会话 summary+增量缓存）/Web UI 三家（opencode SSE+coalesce 16ms 帧+Worker 高亮+虚拟列表·harness WS 下行+flow layout·aider Streamlit——ECode 取 REST+SSE+React19+Tailwind）/serve 四家（opencode Basic Auth+workspace 路由·CC 云侧短命 JWT+epoch·harness ACP stdio·codex JSON-RPC 四传输；四家均不内置 TLS——ECode 取独立入口内嵌 node:http 与 TUI 互斥）/手机响应式 web+PWA 优先/IM 渠道现状（微信个人号封号高危不做·企微 API 模式+长连接·飞书优先·建议滑 M13）；2026-08-21 §8 补充（orca/harness 深挖+spike 验证 8/8+三家分离架构实证+多项目主机级拍板+Q1~Q13 闭环） |
| M12 服务化与多端实施方案 | [详设/2026-08-21_后续-M12-服务化与多端实施方案_已完成.md](./详设/2026-08-21_后续-M12-服务化与多端实施方案_已完成.md) | **v1.2 待审核（三角色审阅修订）**：范围重组——**client/server 反转前两阶段（协议收口+daemon 化+TUI 客户端化+四桥实例化）+ token 统计进 M12，Web/手机/IM 滑 M13**；Q1~Q13 决策台账 + 四条铁律 + 双枚举协议 + ApprovalBroker 分策略表（sensitive 永远交互/--yes 不覆盖）+ ProjectRegistry 三道校验 + daemon token（M12 即做）；**§11 实施计划 B0~B9+B8a（makeDeps 参数化前置批；§11.0 进程级状态全量盘点含工具层硬接线；D1~D6 实施决策；20-26 天）**；§12 审阅记录；附录（参考锚点/spike 记录/被否决备选） |
| Agent 成本优化实战文章精华提取 | [解析/2026-08-21_Agent成本优化实战文章精华提取_已完成.md](./解析/2026-08-21_Agent成本优化实战文章精华提取_已完成.md) | 外部文章《Harness 成本篇（百炼账单降 88%）》逐节提取：token 三放大机制/度量三链路/少发七招（删教学文本·system 不进历史·deferred tools·CC 式标准化·skill 单份去重·重复 read 去重·MCP→CLI）/缓存纪律（稳定性分层+尾部断点·显式 vs 隐式实测）/thinking_budget/SubAgent 派发与回传/Hook 四类拦截/模型角色分流/88% 账本；附 16 条原文参考链接 |
| Agent 成本优化 ECode 对照与差距清单 | [解析/2026-08-21_Agent成本优化ECode对照与差距清单_已完成.md](./解析/2026-08-21_Agent成本优化ECode对照与差距清单_已完成.md) | 三路源码核查（feat/m1-heart@9eaecc2）逐项对照+三角色审阅修复（1 P0+13 P1+14 P2，§7 审阅记录）：已同款——system 分段化/每轮重建、CC 式工具标准化、**thinking 四档控制（M4-D9，初版误判已纠）**、Subagent 结论回传+任务书；差距——cache_control 零打标（底座已在，**统计先行打标随后**）、无效轮次检测空白（落点宿主层非 loop）、skill/read 重复注入、缺模型角色指针；7 项机会清单+前置验证+被否决备选+证据行号索引（仅对基线负责）；2026-08-22 主对话亲自复核至 c3ee954 零翻车 |
| 后续 M13 成本优化实施方案 | [详设/2026-08-22_后续-M13-成本优化实施方案_已完成.md](./详设/2026-08-22_后续-M13-成本优化实施方案_已完成.md) | **已完成（经 M13 合并版实施）**：对照清单六项落地——cache_control 尾部单断点（Provider 层+探针先行）/ 无效轮次检测（宿主层三类：复读指纹·PostToolUse 同参·空错，afterTools feedback+abort，loop 零改动）+审批 15 分钟超时 / skill·read 去重（ctx.session 窄端口扩展）/ 压缩摘要 roles 单角色分流 / 子代理超时自总结；MCP deferred 只登记触发器；D1-D9 决策含被否决备选；B0-B5 六批约 5.5 人天，B5 依赖 M12 token 统计先行；非目标明确排除空回答丢弃/相似度匹配/四角色 registry。**终局：B1-B4 经合并版落地（提交 2230f0f/07bd48d/cc64907/2d4e9d9），B0 探针证明 GLM 端点自动 KV 缓存 → B5 显式打标取消（#1 关闭）** |
| 后续 M14 TUI 超屏防护与输出查看器实施方案 | [详设/2026-08-24_后续-M14-TUI超屏防护与输出查看器实施方案_待启动.md](./详设/2026-08-24_后续-M14-TUI超屏防护与输出查看器实施方案_待启动.md) | **v1.3 待启动（2026-08-27 用户审阅通过+D9 拍板）**：根因实证（ink 7.1.1 溢出兜底 `ESC[2J+3J+H` 清 scrollback 致视角跳顶滚不动，Windows 恰满屏也触发 #969）→ 路线拍板**预算守卫**（动态区帧高恒 ≤ rows−2；fork 渲染器/全屏接管/insert-history 三备选否决记录）——V1 useViewport+foldLines 物理行截断/V2 六溢出源装预算（流式·Ctrl+O 展开·粘贴·面板）/V3 **OutputViewer** 固定高度滚动窗（PanelShell 骨架+LineSource 三源：工具全文·后台任务 attach 实时 tail·子代理 transcript；`/output` 入口+任务状态行+follow/搜索）/V4 轮末延迟 commit 查因二选一/V5 sectionBudget 总守卫+退化保护；硬验收=全交互序列 ESC[3J 不再出现+10 万行 attach 流畅。**§8 全项目挂账收编**（六处来源逐项代码核验，修正三处口径+逮出审阅漏登 P1-6/P1-12）——债清偿线 C1-C5（协议收口/安全加固/宿主工程/web 对等/尾巴）+**产品化线 R1-R5**（D9 拍板并入 M14 不立 M15：配对/中继/E2EE/微信 ClawBot/企微，骨架含 orca 四硬骨头+信任根迁移+微信鉴权约束）。**四角色审阅修复 v1.2**（P0×3：C1⑤ TUI 同帧消费证伪两侧改造同批/C1① 拆 a-b 事件重放缓冲移 R2/D9 论据改既成事实；凭据条目化提前 C2①（D13）/mux phantom subscriber C2⑧/C3⑤ 改 serve 补加载/claim=advisory+TTL（D12）/V2 粘贴行防回退）；估时：C 线 8-9.5、V+C ≈13-15、R ≈13-15+，**三线合计 ≈26-30 人天**；D9-D13 台账+真机门与按需档；挂账：前台 bash 实时流 P2/渲染器 fork 观察项/diff 面板底座。**V+C 两线已全部实施完成（2026-08-27 十三批 9f94b99→7f8af5a，1346+3skip；§3.3/§5 已回填；V5 真机验收探针过——全程无 ESC[3J）** |
| 后续 M14 产品化线 R 实施方案 | [详设/2026-08-27_后续-M14-产品化线R实施方案_待审核.md](./详设/2026-08-27_后续-M14-产品化线R实施方案_待审核.md) | **v1.0 待审核**：orca 两路源码细读回填的 R1-R5 细化方案——威胁模型八条（中继不可信 E2EE/公钥 pinning 防调包/token 泄漏吊销/密文重放/旧连接复活/微信冒用/审批误应答/本机进程代答）/总体架构（daemon 纯出站 WS+direct·relay 双 transport 并存，MuxFrame 信封整体作 E2EE 明文载荷）/现状接缝盘点（C2① CredentialStore·muxFilter·canAnswer·claim TTL·审计五个消费点已就绪）/R1 配对（offer schema+4 帧握手+DeviceEntry 不变量+吊销三步序+scope×reach 正交——orca 实测无滚动过期故 D7 倾向不做）/R2 中继（控制信道 4 步握手+generation·resumeSecret·lease rebind 语义+双侧看门狗 15s·75s+director 自部署单 cell 简化+host-proof 16 字段 transcript）/R3 E2EE（v2 nonce 确定性布局 sessionId‖方向‖帧类型‖计数器+严格递增+HKDF 双向分钥三段+v1 五缺陷勿重踩；X25519 WebCrypto 全支持已核验两端零第三方库）/R4 微信 ClawBot iLink 三限制内建+企微/R5 自部署文档；D1-D7 决策点待拍板；13-15+ 人天 |

| 后续 Dogfood 实测修复方案 | [详设/2026-08-28_后续-Dogfood实测修复方案_已完成.md](./详设/2026-08-28_后续-Dogfood实测修复方案_已完成.md) | **v1.9 全部收官（+清账批 I/II）**：七批提交链（批1 4575e92→批2a F-18 根修→批2c be3ccd7→批2d 15b9957+9c87945 Notification+BEL→serve 事件驱动 ≈1.0×→批2b 9c12ab1 审批卡五条→批2b-fix 7b88970 审阅修复）；批2b 四角色审阅 §13.8/§13.8a（P0×5+偏差②裁决=明示口径；1449）；**功能测试批 §13.4a 六项全通**（MCP 全链/skill 双触发/auto-memory/四面板/CC 对比锚点 4/4）+F-24 skill junction 静默跳过+F-28 skillTool 注册表劈叉（makeSkillTool 工厂）已修，F-23 serve 命令分流/F-26 /output 裸 id 入档；**界面批 §13.5 七项**（@补全/历史+Ctrl+R/单工具展开/scrollback 零改动结论/acceptEdits 五档+档位可视化/双击Esc rewind——1493 总+双探针过）；**清账批 I/II §13.9/§13.10**（F-23 serve 命令分流/F-26/F-27 stop/**批量 cleanup——flake 6→2**/F-29 web warn 假完成/F-09/F-06/F-11）；F 台账 P0 清零、P1 在账 F-16+F-07（三键待拍板）；效率基线 3-5×→1.3×→serve ≈1.0×+skill 沉淀 |
| CC 与 ECode 对话界面对比 | [解析/2026-08-28_CC与ECode对话界面对比_已完成.md](./解析/2026-08-28_CC与ECode对话界面对比_已完成.md) | **已完成（Claude Code 真机产出）**：逐维度对比（输入区/消息流/工具展示/权限档位/状态栏/滚动历史/其他）——高价值借鉴四项（@文件补全/输入历史持久化+Ctrl+R/单工具级展开/transcript 入 scrollback）+中价值六项（!shell 直通/审批附注释/acceptEdits 档/档位可视化/会话头 box/双击 Esc rewind）；ECode 反超点五项（视口预算体系/投影分离标记/告警中心/多端审批/组级聚合）——界面批直接输入 |
| CC 与 ECode Headless 事件流对比 | [解析/2026-08-28_CC与ECode-Headless事件流对比_已完成.md](./解析/2026-08-28_CC与ECode-Headless事件流对比_已完成.md) | **已完成（ECode serve 会话产出，锚点抽查 4/4）**：CC `-p` stream-json（24 帧 SDKMessageSchema/result 终帧富化/三路审批通路含 hook 竞速）vs ECode mux（30 帧/seq 单调/pending 重放）——**ECode 接入成本反超**（重连/游标/鉴权/多项目聚合内置）；可借鉴六条（result 终帧富化/system-init 自描述帧/hook 竞速/审批 suggestions/streamlined 低带宽帧/stdout 守卫）——serve 产品化线输入 |
| Web 端六项目对标调研（opencode/harness/OpenHands/LibreChat/lobe-chat/NextChat） | [解析/2026-08-30_Web端调研-opencode-app_已完成.md](./解析/2026-08-30_Web端调研-opencode-app_已完成.md) 等六篇 | 六篇逐项目源码分析（各含技术栈/事件消费/流式渲染/列表/审批/移动端/扩展机制 + 对 ECode 借鉴清单与反面）：opencode（SSE 合并-分帧/块投影+remend+Worker 高亮/审批 dock+父链继承/refcount 订阅）、harness（快照帧收敛/takeover 链+分区命名法/增量冻结渲染/四态点/让步链）、OpenHands（双轨事件 store+rAF 批处理/EventGroup 折叠/工具卡注册表/无依赖 LCS DiffView/REST+since 重连）、LibreChat（分块 memo 流式/无 key 流式期/侧栏 IA/warm-cache+渐进挂载/抽屉手势）、lobe-chat（虚拟化三规则/操作注册表/300ms 节流状态机/__MOBILE__ 双构建/令牌管线）、NextChat（rAF 打字机/持久化水合门+迁移链/3 页窗口/移动 iOS 包/撤销 toast） |
| Web 端设计与升级方案 | [详设/2026-08-30_后续-Web端设计与升级方案_已完成.md](./详设/2026-08-30_后续-Web端设计与升级方案_已完成.md) | 六项目调研汇总：现状盘点+结论矩阵；升级 W 线（W1 流式分块管线/W2 长会话容量三档/W3 列表升级（分组/搜索/重命名/四态点）/W4 diff 卡/W5 操作注册表/W6 审批 dock/W7 移动细节包/W8 语义令牌/W9 since 游标/W10 插话对齐）；扩展预留 E 线（工具卡注册表/composer 分区/工作区右栏/i18n/分享/主题生成）；不做清单；四批排期；Q1-Q6 已拍板，W 线批 1-4 全部实施（虚拟化/合帧/归档/diff 卡/操作注册表/令牌层/游标） |
| TUI 活动流统一布局详设 | [详设/2026-09-02_后续-TUI活动流统一布局详设_待审核.md](./详设/2026-09-02_后续-TUI活动流统一布局详设_待审核.md) | **v1.7 待审核（七角色两轮审阅全落：四角色+渲染向三角色）**：轮内 LLM 产出（文本/思考/调用）统一为一条时间线（CC 截图+ZCode 实测双参照）——TurnTimeline/思考链路四层打通/loading 动态化/超限折叠五状态机/Ctrl+T 唯一全文入口/D15 diff 不折叠/web·移动结构图+W-T1~T5；**v1.5 四角色**：D9 翻案双帧+itemId 同源修 web 永挂 P0+degraded caret 档+ThinkingLine 五接线点；**v1.7 渲染三角色**：**B4b 规范同步批**（活文档 #15 五类触发全中，六处条文修订+D1/D3 翻案留痕+grid-check G2/G3 改写）/ToolLine 显式 mode 参数（onToggle-proxy 不可迁移）/终态文本计价重写（Markdown 不可预估——最新段 MD+超限整段降级）/新渲染面净化条款（digest/thinking tail）/makeToolDigest+TimelineEntry 落 protocol 单源/renderCommitted 第六接线点归 B2/diff 计价补附属行（+2/条目直通 3J）/loading 整行单物理行/性能四件套（reducer 恒等+memo+fold 缓存+合帧实做）/ASCII 降级代码落点/探针 O4 改造；B1-B6+B4b 批 ≈8-9 人天 |
| 真机诊断修复方案 | [详设/2026-09-02_后续-真机诊断修复方案_待审核.md](./详设/2026-09-02_后续-真机诊断修复方案_待审核.md) | **v1.1 待审核（四角色审阅修订回填）**：搜题平台三连症（卡顿/Ctrl+C 迟滞/客户端 1.3G）全根因实证收编——P0-A 四件（**signal 挪 create() 第二参一行修复为根因**·v1.0「fetch 规范」归因经实验证伪留痕；逐 chunk 检查为二道保险·break 自动断 TCP 无需手动关闭面；TUI「中断中…」提示；压缩链盲区自动覆盖）、P0-B 看门狗（挂账③：零**内容性** delta 90s→**显式转译 STREAM_STALL error delta**（SDK 吞 AbortError/anthropic 误判用户中断）→仅零产出重试 1 次防黏连污染→二次 retryable:false）、P1-A live 链路全面增量化（折叠 O(n²)+thinking 路径更烫+ToolLine 引用恒等+尾行超宽退化+新专用探针+heapUsed 强制 GC 对照）、P1-B B1 恒留+pinnedKeys 泛化+宽度账（留拍板位）；批1a/1b 拆两笔提交；≈3 人天 |
| 真机修复方案四角色审阅 | [解析/2026-09-02_四角色真机诊断修复方案审阅_已完成.md](./解析/2026-09-02_四角色真机诊断修复方案审阅_已完成.md) | **根因翻案（最重）**：初诊"fetch 规范"失实——真根因是 openai.ts 把 signal 传进 create() body 参数（v7 只认第二参，signal 从未到达 fetch），复现脚本照抄同 bug；一行修复免费解锁静默流中断。P0×5（stall 须显式转译 error delta——SDK 吞 AbortError/anthropic 误判用户中断；透明重试黏连污染 5 消费点；run() 无 mock 通路）+P1×11（thinking 路径更烫/ToolLine 引用恒等/验收须新建专用探针/B1 宽度账）+P2 若干；两角色独立推荐 P1-B=B1 恒留+pinnedKeys 泛化；四角色一致"改后过"，修订已回填方案 v1.1 |

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
