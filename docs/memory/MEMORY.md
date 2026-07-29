# ECode 项目记忆索引

> **跨设备同步的记忆层**。纳入 git 跟踪，`git pull` 即同步——不依赖某台机器的本地 `~/.claude/`（不同设备用户名/路径不一致会丢）。
>
> **AI 会话开始时**：读本文件了解项目状态；产生新决策/踩坑时，回写对应分类文件，并在下方索引追加一行。
> 规则详见 [CLAUDE.md §八](../../CLAUDE.md)。

---

## 当前状态（一眼概览）

- **里程碑**：M1（Agent Loop）进行中
- **已实现**：tool_use / tool_result 工具调用循环、`read_file` + `bash` 工具、运行时全量日志（`docs/logs/runtime/`）
- **下一焦点**：M1 收尾验证 → M2 多模型适配
- **环境**：默认走 DeepSeek 兼容端点（`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`），模型 `deepseek-v4-pro`；`.env` 由 `npm run dev` 自动加载

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
