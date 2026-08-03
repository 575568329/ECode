# ECode 项目记忆索引

> **跨设备同步的记忆层**。纳入 git 跟踪，`git pull` 即同步——不依赖某台机器的本地 `~/.claude/`（不同设备用户名/路径不一致会丢）。
>
> **AI 会话开始时**：读本文件了解项目状态；产生新决策/踩坑时，回写对应分类文件，并在下方索引追加一行。
> 规则详见 [CLAUDE.md §八](../../CLAUDE.md)。

---

## 当前状态（一眼概览）

- **定位**：开源产品（对标 Claude Code），交付优先——2026-07-30 从"学习项目"转型
- **里程碑**：M2 完成（Provider 抽象：Claude/OpenAI 双协议 + config + factory + --model CLI），下一 M3 → M3.5
- **已实现**：M1 全部 + Provider 层（types/transform/claude/openai/config/factory）+ agent 解耦 SDK + tools 协议中立化 + CLI --model；49 单测；OpenAI 协议端到端实跑通过（deepseek-chat + 工具）
- **下一焦点**：M3 上下文压缩 + Session（数据层）→ M3.5 交互式 CLI 体验（沉浸 REPL / slash 命令 / 流式渲染 / 中断）
- **环境**：M2 起 config.json 驱动（`DEEPSEEK_API_KEY` / `ZHIPUAI_API_KEY` / `ANTHROPIC_API_KEY`，OpenAI 兼容协议）；`.env` 由 `npm run dev` 自动加载

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
- [debugging.md](./debugging.md) — 踩坑：#001 `--env-file` 不覆盖继承的 env / #002 `env -i` 丢 TMPDIR / #003 fast-glob ESM named export（vitest 假过）
