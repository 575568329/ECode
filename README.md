# ECode

> 用 TypeScript + Node.js **手写**一个生产可用的开源 AI coding agent（对标 Claude Code / opencode）。
> **拒绝框架黑盒**：agent loop、Provider 适配、上下文管理都自己写，自主掌控每一个环节。

---

## 这是什么

一个命令行 AI 编程助手，核心能力：

- **多模型支持** — 配置驱动，Claude / OpenAI / GLM / DeepSeek 及任意 OpenAI/Anthropic 兼容模型，CLI 一键切换
- **手写 Agent Loop** — 自己实现 `tool_use` / `tool_result` 工具调用循环，不用 LangGraph 等框架
- **实用工具集** — 文件读写编辑、代码搜索（grep/glob）、shell 执行
- **上下文自动整理** — 长对话不"变傻"：token 计数 + LLM 摘要压缩
- **分级权限系统** — default / acceptEdits / plan / bypass，危险命令拦截
- **混合流式输出** — 文本流式显示，工具调用完整接收后执行

## 为什么从零手写

社区共识："The first time you write the loop yourself, the framework stops being magic and becomes a thing you understand."

手写不是为了重复造轮子，而是为了**自主可控**：核心逻辑（agent loop、上下文管理、权限）不假手于框架，才能在出问题时真正定位和演进。理解是实现这个目标的前提，不是终点。

## 技术栈

- **语言**：TypeScript（strict 模式，禁用 `any`）
- **运行时**：Node.js（多端运行，`tsx` 直跑 TS）
- **测试**：Vitest（核心逻辑 TDD）
- **关键依赖**：`@anthropic-ai/sdk`、`openai`、`ai-tokenizer`

## 开发路线（里程碑）

| 里程碑 | 交付目标 | 状态 |
|--------|---------|------|
| **M1** Agent 的心脏 | 工具调用协议、while 循环、id 配对约束 | 🔄 补全中（骨架已完成） |
| **M2** 多模型适配 | 各家协议差异、Provider 抽象、能力探测 | ⬜ |
| **M3** "记不住"问题 | 上下文压缩、token 计数、结果截断 | ⬜ |
| **M4** "信任问题" | 权限哲学、编辑正确性、错误恢复 | ⬜ |
| **M5+** 进阶 | 可观测性 / 测试 / Repo Map / Subagent | ⬜ |

完整规划见 [docs/总纲/00-开发规划.md](docs/总纲/00-开发规划.md)。

---

**状态**：M1 补全中（骨架已完成，补到"真能用"）
**性质**：开源项目（对标 Claude Code）
