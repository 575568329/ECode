# AGENTS.md — ECode 工作区指令

> 给后续 ZCode agent 的工作区须知。改动代码或文档前先读这份。

## 这是什么项目

ECode 是一个**终端 Agent CLI**：以 AgentLoop 为心脏，其余能力（工具、模型接入、TUI、斜杠命令、历史、配置、日志）作为分支接入心脏。形态对标 Claude Code / Aider。

**当前状态：设计完成，代码未启动**（M1 未开始，尚无 `package.json`）。所有设计在 `docs/`。

## 动手前必读

- **权威设计文档**：[`docs/详设/2026-08-11_ECode-MVP详设_待审核.md`](docs/详设/2026-08-11_ECode-MVP详设_待审核.md)（v3，含评审修订 + 日志系统）。改任何核心模块前先读对应章节。
- **评审报告**：[`docs/解析/2026-08-11_MVP详设评审报告_待审核.md`](docs/解析/2026-08-11_MVP详设评审报告_待审核.md)——记录了已修的坑和决策理由。
- **docs 索引与约定中心**：[`docs/README.md`](docs/README.md)——文档结构、命名约定、写作规范都在这一份。

## 技术栈（已定，待 scaffold）

- 语言/运行时：**TypeScript 严格模式** / Node.js
- TUI：**Ink**（类 React 终端渲染）
- LLM：**`@anthropic-ai/sdk`** 接 **Astron 的 Anthropic 兼容端点**（跑 GLM）
- 校验：**AJV**（JSON Schema 原生，零转换；MVP 不引 Zod）
- 运行/测试：**tsx**（跑 TS）/ **vitest**

> 无 `package.json` 时不要假设构建命令。scaffold 后用 `npx tsx src/cli/index.ts` 跑、`npx vitest` 测试。依赖锁主版本（见详设第 9 节）。

## 架构铁律（违反即设计缺陷）

**心脏（AgentLoop）永远不出现 `if provider === 'xxx'` 这类判断**——所有协议差异封在 Provider 实现内部。一旦这类判断钻进心脏，抽象就泄漏了。

三层架构：
```
AgentLoop（心脏）
  ├─ LLMProvider Registry（可插拔分支面）
  ├─ Tool Registry（可插拔分支面）
  └─ 内置分层服务（直接接入，YAGNI，不走 Registry）:
     Config · HistoryStore · LogStore · CommandRegistry · Logger · Permissions
```

加新工具/新模型 = 写实现 + `register()`，心脏零改动。

## 规划的 src/ 结构（详设第 7 节）

```
src/cli        入口（解析 argv、加载 config、启动 TUI）
src/core       心脏（loop / types 规范模型 / errors）
src/providers  LLMProvider 分支（interface / registry / anthropic / [openai 预留]）
src/tools      Tool 分支（interface / registry 含 AJV / builtin 6 工具）
src/commands   斜杠命令（interface / registry / builtin: help/clear/model/history）
src/services   内置服务（config / history / logger / logstore / redact / permissions）
src/tui        Ink TUI（App / render / components）
tests/         镜像 src 结构
```

## MVP 范围（详设 0.4 节）

**做**：AgentLoop（多轮+工具+流式）、1 个 Provider（Anthropic→GLM）、6 内置工具（read_file/write_file/edit_file/glob/grep/bash）、TUI（流式+中断）、4 斜杠命令、历史持久化、配置系统、全量日志（LogStore）。

**不做（留后续版本）**：MCP 客户端、子 agent / 多 agent 编排、上下文自动压缩、多 provider 路由。文件名带 `后续-` 的文档不是现在要做的。

## 关键设计约束（容易踩的）

- **LogStore ≠ HistoryStore**：LogStore 是运行日志（trace，给调试，**不进 context**）；HistoryStore 是对话 messages（给 LLM、`/history` 恢复）。两者职责分离，通过 `sessionId` 关联。
- **错误契约**：recoverable → 转 `tool_result(is_error:true)` 交 LLM 自纠；fatal → 抛顶层中断 Loop。网络/超时/429/上下文超限都是 recoverable（退避重试或提示），不是 fatal。
- **固化逻辑在 finally**：主循环用 try/finally，无论正常/错误/中断都要把已生成内容固化进 messages 并增量落盘，否则中断会丢对话。
- **bash 工具安全**：强制 timeout（30s）、输出截断（10KB）、危险命令模式拦截（`rm -rf /`、`sudo` 等）、cwd 约束。仅 `readonly:false + y/n` 不够。
- **写工具确认要 diff 预览**：write_file/edit_file 的 ConfirmPrompt 必须带 diff，不让用户盲签。

## 跨平台（开发环境即 Windows / Git Bash）

- 路径统一用 `node:path`，内部表示一律正斜杠；用户目录用 `os.homedir()`，**不要**依赖 shell 的 `~` 展开。
- bash 工具显式依赖 Git Bash；glob 模式用正斜杠。
- 详设 4.6 节有完整跨平台约定。

## 文档约定（docs/）

- **只有顶层一份 README**（`docs/README.md`），子目录不放 README。
- 6 个目录按读者意图分：`大纲/详设/解析/诊断/决策/规范`。
- 文件名格式：`YYYY-MM-DD_[MVP-|后续-]中文名称_状态.md`，状态枚举固定（待启动/进行中/待审核/已完成/已废弃）。
- 范围靠**文件名中间标识**（`MVP-` / `后续-`），不靠子目录。
- 状态变更 = 重命名文件（时间码不变）。
- 决策记录（ADR）只追加不改，要改开新 ADR 标 `supersedes`。

## 当前里程碑

M1（心脏最小闭环）= loop + AnthropicProvider + read_file/bash + Config 最小切片。M1 前置烟测：Astron 端点事件齐全度（stop_reason 取值、usage 字段、stream 事件）。详设第 10 节有 M1-M4 完整里程碑。
