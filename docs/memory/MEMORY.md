# ECode 项目记忆索引

> **跨设备同步的记忆层**。纳入 git 跟踪，`git pull` 即同步——不依赖某台机器的本地 `~/.claude/`（不同设备用户名/路径不一致会丢）。
>
> **AI 会话开始时**：读本文件了解项目状态；产生新决策/踩坑时，回写对应分类文件，并在下方索引追加一行。
> 规则详见 [CLAUDE.md §八](../../CLAUDE.md)。

---

## 当前状态（一眼概览）

- **定位**：开源产品（对标 Claude Code），交付优先——2026-07-30 从"学习项目"转型
- **里程碑**：M3 P1-P4 完成（含 L3 forceCompact 已接线 2026-08-07）；M3.5 交互式 CLI 进行中（REPL/斜杠/折叠/pager/会话/键位分工/多行输入已落地）；**M4 权限系统全 5 阶段完成 2026-08-08**（b60c36b：path-guard + check() 三档 + 修 🔴-2 + bash 命令分级 + settings-loader + CLI 模式切换 + deny 接线 + UI 三态审批/doom-loop/危险高亮，683 单测全绿）；**M5 实施中**（阶段0 地基 + **阶段1 子代理**已落地：Task 工具递归 runAgentStream + 侦察兵黑盒 + 权限⊆A + 防递归 + agents/*.md 人设，719 测试零回归；UI 审阅降级①④ 保黑盒待用户确认；阶段2 Hooks/3 MCP 待）；**M6 设计完成 2026-08-09**（三文档+审阅改定：Skills+模型路由+多渠道，6 致命+8 改进全修，D1-D7 待审阅，代码未开始）
- **已实现**：M1 全部 + Provider 层（双协议/config/factory/--model/**baseURL 三级可配）+ tools 协议中立化 + M3 上下文管理（含 L3 forceCompact 已接线 2026-08-07）+ **M3 P4 Session** + M4 权限系统 + **M5 阶段0 地基 + 阶段1 子代理**（resolveDataDir + tools 注入 + Task 工具递归/黑盒/权限⊆/防递归/agents 人设）；**719 单测**；tsc clean
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
- [decisions.md](./decisions.md) — 决策：#001 token 计数 ai-tokenizer→length/4 / #002 Session 同 id 覆盖（剔除 -2）/ **#003 M5 三支点核心选型（子代理递归/MCP 官方SDK只做Tools/Hooks CC式6事件，2 处待拍板）** / **#004 M6 三支点选型（Skills 三家标准+懒加载/路由规则映射/多渠道服务化，D1-D7 待审阅）**
- [debugging.md](./debugging.md) — 踩坑：#001 env 不覆盖 / #002 env -i 丢 TMPDIR / #003 fast-glob ESM / #004 LLM 知识失真 / #005 上下文超限恢复 / #006 GLM 端点 / #007 Session ID 碰撞→UUID / #008 全功能日志覆盖 / #009 `<Static>` append-only→换 key 重 mount / #010 文档 file:line 漂移 / **#011 Windows CRLF 陷阱** / **#012 Windows bash 三连坑（阻塞+find.exe+GBK）** / **#013 ink `exitOnCtrlC` 默认 true → Ctrl+C 逻辑成死代码 + testing 盲区** / **#014 中断识别用 signal.aborted 不用 instanceof（SDK 包装的 abort 错误漏判→显示 ✗ Request was aborted）** / **#015 M5 三源联网研究推翻 7 处早先假设（不瞎想实证）** / **#016 `npm test` 是 watch 模式（全量一次性用 `npx vitest run`）**
- [preferences.md](./preferences.md) — 偏好：防假绿 5 条 testing 约定（L2 ink 测试必守）
