# Changelog

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### v0.2.0 — 首次公开发布（M1-M6 完整版）

> v0.1.0 为内部开发版本，从未公开发布。v0.2.0 为首个正式发布版本，汇总 M1-M6 全部能力。

#### M6 收尾里程碑（收尾 + 扩展）

- **npm 发布适配**：`files` 白名单（只发 dist + 文档，排除 tests/src/.env）、`prepublishOnly` 构建测试兜底、`repository` / `homepage` / `bugs` 元数据、LICENSE 文件、CHANGELOG、README 完整化
- **模型路由 alias 解耦**：`src/router/` 纯函数 `resolveAlias`（cheap/strong/reasoning 逻辑别名 → 具体 provider+model），解耦 Skill frontmatter model 字段与底层模型
- **Skills 系统**（规划中）：手写加载 + 自动生成（Stop hook 归纳 + 安全扫描 + 提案）
- **多渠道服务化 + Web 前端**（规划中）：本地 HTTP+WS 服务化 + React Web 工程
- **Repo Map 拆为独立扩展包**：核心预留「上下文增强」接口，Repo Map（tree-sitter WASM + PageRank）作可选 npm 包，核心不携带大体积原生依赖

#### M5 三支点（进阶能力）

- **子代理**：Task 工具递归调用 + 侦察兵黑盒模式 + 权限 ⊆ 父代理 + 防递归保护 + agents 人设
- **Hooks 引擎**：Pre/Post 决策引擎 + 6 事件流（PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart/SessionEnd）+ 系统级 hook 强制叠加 + settings.json 配置加载
- **MCP 全链路**：官方 `@modelcontextprotocol/sdk` + Tools/Prompt 适配器 + client RCE 白名单 + 斜杠命令注册式加载 + `/mcp` 管理命令（info/tools/reconnect/add/remove）+ 连接池 + 进程树清理（Windows taskkill / POSIX pgrep，全平台唯一）

#### M4 权限系统（信任问题）

- `path-guard` 路径守护 + `check()` 三档决策（default / acceptEdits / plan / bypass）
- `settings-loader` 两层首启自动生成 + CLI 模式切换 + deny 接线
- bash 命令分级（只读 / 写 / 危险）+ UI 三态审批 + doom-loop 防御 + 危险操作高亮

#### M3.5 交互式 CLI（体验打磨）

- REPL 交互循环 + 斜杠命令系统（注册式重构）+ 工具结果折叠策略 + pager（Ctrl+O）+ 会话持久化 + 键位分工 + Shift+Enter 多行输入

#### M3 上下文管理（"记不住"问题）

- token 计数 + 三级压缩（L1 结果截断 / L2 LLM 摘要 / L3 forceCompact 强制压缩）+ Session 持久化（`~/.ecode/sessions/`）+ 上下文超限自动恢复

#### M2 多模型适配（协议差异）

- Provider 抽象 + 双协议适配（OpenAI / Anthropic 兼容）+ `~/.ecode/config.json` 驱动（providers/models/capabilities）
- GLM / DeepSeek / Claude 三 provider 内置 + `apiKeyEnv` 环境变量注入（不明文存 key）+ baseURL 三级可配（env > config > 协议默认）+ `--model` 运行时切换

#### M1 Agent 心脏（核心）

- 手写 agent loop（`tool_use` / `tool_result` id 配对约束 + while 循环 + 消息累加），不使用 LangGraph 等框架
- 工具集：文件读写 / 编辑（diff） / grep / glob / bash（异步 + 输出合并）
- 混合流式输出：文本流式显示，工具调用完整接收后执行
- runtime-logger 全量调试日志（`~/.ecode/logs/`）

### 基础设施

- TypeScript strict（`noUnusedLocals` / `noUnusedParameters`）+ ESM（import 带 `.js`）
- Vitest TDD（800+ 单元测试）+ 跨设备数据目录统一入口 `resolveDataDir()`
- 跨 Windows/WSL 混合环境兼容设计（见 CLAUDE.md §9.3）

---

## 版本规划

- **v0.2.0**：M1-M6 完整版首次公开发布（当前里程碑 M6 进行中）
- 后续：Repo Map 独立扩展包、Skills 自动生成、多渠道 Web 前端
