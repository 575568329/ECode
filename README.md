# ECode

> 用 TypeScript + Node.js **手写**的生产级开源 AI coding agent（对标 Claude Code / opencode）。
> **拒绝框架黑盒**：agent loop、Provider 适配、上下文管理、权限系统全部从零实现，自主掌控每一个环节。

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)]()

---

## ✨ 特性

- 🔧 **手写 Agent Loop** — 自己实现 `tool_use` / `tool_result` 工具调用循环（id 配对 + 消息累加），不用 LangGraph 等框架
- 🤖 **多模型支持** — 配置驱动，GLM / DeepSeek / Claude 及任意 OpenAI / Anthropic 兼容模型，CLI 一键切换
- 🛠️ **实用工具集** — 文件读写 / 编辑（diff 预览）/ 代码搜索（grep / glob）/ shell 执行
- 🧠 **上下文管理** — 长对话不变傻：token 计数 + 三级自动压缩（结果截断 / LLM 摘要 / 强制压缩）+ Session 持久化
- 🔒 **分级权限系统** — default / acceptEdits / plan / bypass 四档，路径守护 + 危险命令拦截 + 三态审批
- 🤝 **子代理** — Task 工具递归派发子任务，权限 ⊆ 父代理，黑盒隔离，防递归
- 🪝 **Hooks 引擎** — Pre / Post 决策 + 6 事件流，可拦截、改写工具调用与结果
- 🔌 **MCP 协议** — 接入任意 MCP server（Tools / Prompts），`/mcp` 连接池管理 + 全平台进程清理
- 🖥️ **交互式 TUI** — Ink 流式输出、工具结果折叠、pager（Ctrl+O）、Shift+Enter 多行输入、会话恢复

## 📦 安装

### 全局安装（v0.2.0 发布后）

```bash
npm install -g ecode
```

### 从源码构建

```bash
git clone https://github.com/575568329/ECode.git
cd ECode
npm install          # 统一 npm（见红线：禁用 pnpm / yarn）
npm run build
```

## 🚀 快速开始

### 1. 配置 API Key

复制环境变量示例并填入你的 key（`.env` 已被 gitignore，不会提交）：

```bash
cp .env.example .env
```

编辑 `.env`（默认走 GLM 智谱，模型 `glm-5.2`）：

```bash
# 从 https://open.bigmodel.cn/ 获取
ZHIPUAI_API_KEY=sk-your-glm-key

# 可选：DeepSeek / Claude
# DEEPSEEK_API_KEY=sk-your-deepseek-key
# ANTHROPIC_API_KEY=sk-ant-api03-...
```

### 2. 运行

开发模式（`tsx` 直跑 TS，自动加载 `.env`）：

```bash
npm run dev -- "帮我看一下这个项目的结构，列出主要模块"
```

构建后运行：

```bash
npm run build && npm start -- "任务描述"
```

## ⚙️ 配置

ECode 配置分两层：**环境变量**（`.env`，注入 API key）+ **配置文件**（`~/.ecode/config.json`，驱动模型 / 能力 / 路由）。

### 环境变量（`.env`）

| 变量 | 说明 |
|------|------|
| `ZHIPUAI_API_KEY` | GLM（智谱）API key，默认模型 `glm-5.2` |
| `DEEPSEEK_API_KEY` | DeepSeek（OpenAI 兼容端点） |
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `*_BASE_URL` | 可选，自定义请求地址（baseURL 三级优先级：env > config.json > 协议默认） |

key 通过环境变量注入，不在 `config.json` 里明文存储（安全）。

### 配置文件（`~/.ecode/config.json`）

不存在时使用内置默认（GLM / DeepSeek / Claude 三 provider）。可自定义 `providers` / `models` / `capabilities` / `defaultModel`：

```json
{
  "defaultModel": "glm-5.2",
  "providers": { ... },
  "models": { ... }
}
```

### 运行时切换模型

```bash
ecode --model deepseek-chat "任务"
```

或在 TUI 内 `/model deepseek-chat`。

## 🎮 用法

### CLI

```bash
ecode "<任务>"                     使用默认模型
ecode --model <name> "<任务>"      指定模型
```

### 斜杠命令（TUI 内输入）

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/model <name>` | 切换模型 |
| `/compact` | 手动触发上下文压缩 |
| `/cost` | 查看本次会话 token 用量 |
| `/clear` | 清空当前对话 |
| `/resume` | 显示会话恢复面板 |
| `/sessions` | 列出项目会话 |
| `/mcp` | 查看 / 管理 MCP servers |
| `/exit` | 退出 ECode |

### 键位

`Enter` 提交 · `Shift+Enter` 多行输入 · `Ctrl+O` pager 浏览 · `Ctrl+C` 中断

## 🆚 定位

ECode 的核心价值是**学习与自主掌控**。手写不是为了重复造轮子，而是为了——

> "The first time you write the loop yourself, the framework stops being magic and becomes a thing you understand."

核心逻辑（agent loop、上下文管理、权限、Provider 适配）不假手于框架，才能在出问题时真正定位和演进。理解是实现这个目标的前提，不是终点。

- 对标 Claude Code 的完整能力闭环，但**全部开源、手写、配置驱动多模型**
- 不锁定单一模型厂商，GLM / DeepSeek / Claude 等任意兼容模型即插即用
- 跨 Windows / WSL 混合环境兼容设计

## 🛠️ 技术栈

- **语言**：TypeScript（strict 模式，禁用 `any`，ESM）
- **运行时**：Node.js ≥ 18（`tsx` 直跑 TS）
- **TUI**：Ink（React for CLI）
- **测试**：Vitest（核心逻辑 TDD，800+ 单元测试）
- **关键依赖**：`@anthropic-ai/sdk`、`openai`、`@modelcontextprotocol/sdk`、`ink`、`marked`

## 🗺️ 开发路线（里程碑）

| 里程碑 | 交付目标 | 状态 |
|--------|---------|------|
| **M1** Agent 心脏 | 工具调用协议、while 循环、id 配对 | ✅ |
| **M2** 多模型适配 | Provider 抽象、双协议、能力探测、config.json 驱动 | ✅ |
| **M3** 上下文管理 | 三级压缩、token 计数、Session 持久化 | ✅ |
| **M3.5** 交互式 CLI | REPL / 斜杠命令 / 折叠 / pager / 多行 | ✅ |
| **M4** 权限系统 | path-guard / 四档决策 / 三态审批 | ✅ |
| **M5** 进阶能力 | 子代理 / Hooks / MCP 全链路 | ✅ |
| **M6** 收尾发布 | npm 发布 / Skills / 模型路由 / 多渠道 | 🔄 进行中 |

完整规划见 [docs/总纲/00-开发规划.md](docs/总纲/00-开发规划.md)。

## 🤝 贡献

欢迎 Issue / PR。开发约定（编码规范 / 测试策略 / 红线避坑）见 [CLAUDE.md](CLAUDE.md)。

```bash
git clone https://github.com/575568329/ECode.git
cd ECode && npm install
npm run build           # tsc strict
npx vitest run          # 全量测试（npm test 是 watch 模式）
```

## 📄 License

[MIT](LICENSE) © 2026 fjyu9
