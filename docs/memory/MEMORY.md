# ECode 项目记忆索引

> **跨设备同步的记忆层**。纳入 git 跟踪，`git pull` 即同步——不依赖某台机器的本地 `~/.claude/`（不同设备用户名/路径不一致会丢）。
>
> **AI 会话开始时**：读本文件了解项目状态；产生新决策/踩坑时，回写对应分类文件，并在下方索引追加一行。
> 规则详见 [CLAUDE.md §八](../../CLAUDE.md)。

---

## 当前状态（一眼概览）

- **定位**：开源产品（对标 Claude Code），交付优先——2026-07-30 从"学习项目"转型
- **里程碑**：M3 P1-P4 完成（含 L3 forceCompact 已接线 2026-08-07）；M3.5 交互式 CLI 进行中（REPL/斜杠/折叠/pager/会话/键位分工/多行输入已落地）；**M4 权限系统全 5 阶段完成 2026-08-08**（b60c36b：path-guard + check() 三档 + 修 🔴-2 + bash 命令分级 + settings-loader + CLI 模式切换 + deny 接线 + UI 三态审批/doom-loop/危险高亮，683 单测全绿）；**M5 三支点全部完成 2026-08-09**（阶段0 地基 + 阶段1 子代理(76abd74) + 阶段2 Hooks Pre/Post 引擎(e7148a4) + 阶段3 MCP 全链路（R1 SDK + R2 client RCE白名单 + R3 斜杠注册式重构 + R4 adapter + R5 loader接线 + R6 /mcp UI + R7 prompts→斜杠命令 + Hooks settings.json 配置加载）；**MCP 管理增强(支点10) 2026-08-09**：McpManager 连接池+互斥锁/30s 超时+lastError//mcp 子命令(info/tools/reconnect/add/remove)/Windows taskkill+POSIX pgrep 树遍历进程树清理/env 脱敏（删 loader→manager，T9 借鉴 opencode 消除 POSIX 孙子残留，三方唯一全平台），102 mcp 单测，tsc clean）；**M6 实施中 2026-08-09**（重组为收尾里程碑：吸收 M1-M5 收尾 + npm 适配 + Skills/路由/多渠道；Repo Map 拆出后续扩展功能；一口气全做→v0.2.0；D2=服务化+Web 前端；**阶段 A ✅ 完成 2026-08-09**：文档刷新 + homedir 收口实证（数据目录已收口 / index.ts 指令加载提取 buildSystemInstructions helper）+ 路由 alias 解析器纯函数 src/router/（6 单测，851 全绿）；**阶段 B ✅ 完成 2026-08-09**：npm 发布适配（files 白名单/prepublishOnly/repository/LICENSE/CHANGELOG/README 全补，npm pack 无敏感泄漏 253.6kB）+ 真实 GLM 端到端连通验证（stopReason=stop, reply 正常））；**阶段 C ✅ 完成**：cost 精确化（支点17 单价驱动 + inputTokens 统一含 cache）+ Hooks Stop 事件流（emit 聚合 + 四注入点 + Stop deny 打回续跑）；**阶段 D 🚧 主体完成**：阶段1 Skills 手写完整（loader/catalog/matcher + system 注入 + /skill 命令）+ 阶段3 路由核心+接线（rules 纯函数 + router/config.ts routing 读取 + global/compress/subagent 三触发点）+ 阶段2 security-scan 核心；908 全绿）
- **已实现**：M1 全部 + Provider 层（双协议/config/factory/--model/**baseURL 三级可配）+ tools 协议中立化 + M3 上下文管理（含 L3 forceCompact 已接线 2026-08-07）+ **M3 P4 Session** + M4 权限系统 + **M5 全三支点**（resolveDataDir + tools 注入 + Task 工具递归/黑盒/权限⊆/防递归/agents 人设 + hooks runner/inject/system/agent/settings接线 + mcp registry/adapter/client-RCE白名单/loader/prompts→斜杠命令）；**908 单测**（排除 flaky mcp-client）；tsc clean
- **环境**：M2 起 config.json 驱动（`DEEPSEEK_API_KEY` / `ZHIPUAI_API_KEY` / `ANTHROPIC_API_KEY`，OpenAI 兼容协议）；`.env` 由 `npm run dev` 自动加载；会话落盘 `.ecode/sessions/`（已 gitignore）

---

## 分类文件

| 文件 | 内容 | 何时读 |
|------|------|--------|
| [project.md](./project.md) | 项目性质、架构骨架、里程碑进度、当前焦点 | **每次会话开始** |
| decisions.md | 技术选型 / 架构决策及原因 | 动手做技术选型前 |
| preferences.md | 编码 / 工作偏好（本项目专属） | 按需 |
| procedures.md | 可复用操作流程（发布、调试步骤等） | 执行重复任务前 |
| debugging.md | 踩坑记录与解决方案 | 排查类似问题时 |

> 未创建的文件**按需新建**（不要建空文件），建后在下方索引登记一行。
> 命名规则、写入流程见 [CLAUDE.md §八](../../CLAUDE.md)。

---

## 索引（每条记忆一行，新建后追加）

- [project.md](./project.md) — 项目性质 / 架构骨架 / 里程碑进度 / 当前焦点
- [decisions.md](./decisions.md) — 决策：#001 token 计数 ai-tokenizer→length/4 / #002 Session 同 id 覆盖（剔除 -2）/ **#003 M5 三支点核心选型（子代理递归/MCP 官方SDK只做Tools/Hooks CC式6事件，2 处待拍板）** / **#004 M6 三支点选型（D1-D7 已敲定：一口气全做/服务化+Web/规则映射/复用dialog/自动扫；D6 死）** / **#005 Repo Map 不进 M6→扩展化（核心留接口+独立可选包+web-tree-sitter WASM）**
- [debugging.md](./debugging.md) — 踩坑：#001 env 不覆盖 / #002 env -i 丢 TMPDIR / #003 fast-glob ESM / #004 LLM 知识失真 / #005 上下文超限恢复 / #006 GLM 端点 / #007 Session ID 碰撞→UUID / #008 全功能日志覆盖 / #009 `<Static>` append-only→换 key 重 mount / #010 文档 file:line 漂移 / **#011 Windows CRLF 陷阱** / **#012 Windows bash 三连坑（阻塞+find.exe+GBK）** / **#013 ink `exitOnCtrlC` 默认 true → Ctrl+C 逻辑成死代码 + testing 盲区** / **#014 中断识别用 signal.aborted 不用 instanceof（SDK 包装的 abort 错误漏判→显示 ✗ Request was aborted）** / **#015 M5 三源联网研究推翻 7 处早先假设（不瞎想实证）** / **#016 `npm test` 是 watch 模式（全量一次性用 `npx vitest run`）**
- [preferences.md](./preferences.md) — 偏好：防假绿 5 条 testing 约定（L2 ink 测试必守）
