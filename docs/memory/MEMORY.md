# ECode 项目记忆索引

> **跨设备同步的记忆层**。纳入 git 跟踪，`git pull` 即同步——不依赖某台机器的本地 `~/.claude/`（不同设备用户名/路径不一致会丢）。
>
> **AI 会话开始时**：读本文件了解项目状态；产生新决策/踩坑时，回写对应分类文件，并在下方索引追加一行。
> 规则详见 [CLAUDE.md §八](../../CLAUDE.md)。

---

## 当前状态（一眼概览）

- **定位**：开源产品（对标 Claude Code），交付优先——2026-07-30 从"学习项目"转型
- **里程碑**：M3 P1-P4 完成（格式 v2 + 声明式工具 + token 计数 + 截断 + 上下文压缩 + **Session 持久化**）；⚠️「超限响应式恢复」L3 forceCompact 已实现但 **agent.ts 未接线（死代码）**，见 [debugging.md #005 纠正](./debugging.md) / [审查报告 🔴-1](../总纲/ECode项目审查报告.md)；下一 P5 伴随特性 → M3.5
- **已实现**：M1 全部 + Provider 层（双协议/config/factory/--model/**baseURL 三级可配：env>config>内置，GLM 默认走 coding plan 端点**）+ tools 协议中立化 + M3 上下文管理（token-counter/context-manager 含 trim+级联/截断；⚠️ forceCompact 已实现但 agent.ts 未接线）+ **M3 P4 Session**（session.ts 纯数据层 + agent loop 挂载 + CLI --continue/-c/--resume/--sessions）；**400 单测**；tsc clean
- **下一焦点**：P5（并行只读工具 / retry 读 Retry-After / usage 细化）→ M3.5 交互式 CLI
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
- [decisions.md](./decisions.md) — 决策：#001 token 计数 ai-tokenizer→length/4 / #002 Session 同 id 覆盖（剔除 -2）
- [debugging.md](./debugging.md) — 踩坑：#001 env 不覆盖 / #002 env -i 丢 TMPDIR / #003 fast-glob ESM / #004 LLM 知识失真 / #005 上下文超限恢复 / #006 GLM 端点 / #007 Session ID 碰撞→UUID / #008 全功能日志覆盖 / **#009 `<Static>` append-only→换 key 重 mount**
- [preferences.md](./preferences.md) — 偏好：防假绿 5 条 testing 约定（L2 ink 测试必守）
