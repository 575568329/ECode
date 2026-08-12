# ECode

> 终端 Agent CLI —— 以 **AgentLoop 为心脏**，工具 / 模型接入 / TUI / 历史 / 配置作为分支接入心脏。形态对标 Claude Code / Aider。
>
> 技术栈：TypeScript 严格模式 · Node.js · Ink（TUI 待 M2）· `@anthropic-ai/sdk` 接 GLM-5.2

## 现状

- **M1 心脏最小闭环已完成** ✅ —— 终端跑通一轮：提问 → LLM 调 `read_file`/`bash` → 回答
- 设计文档齐全（[`docs/`](docs/README.md)），代码 M1 完成，M2-M4 待启动
- 测试 45/45 全绿 · 真 LLM 烟测通过（GLM-5.2 经智谱 Anthropic 兼容端点）

## 快速开始

```bash
npm install

# 配置（二选一）
# 1) 编辑 ~/.ecode/config.json（首次运行会自动生成带注释的模板，填 apiKey 即可）
# 2) 或项目根 .env（dev，参考 .env.example）

# 单次问（跑一次退出）
npm run dev -- "读 package.json 并告诉我版本"

# 交互式 REPL（多轮对话，Ctrl+C 退出）
npm run dev
```

## 命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 REPL；`npm run dev -- "问题"` 为单次模式 |
| `npm test` | 全部单测（vitest） |
| `npm run build` | `tsc` 编译到 `dist/`（发布前置） |
| `npx tsx scripts/smoke.ts` | 真 LLM 烟测（验证端点连通） |

## 能力（M1）

- ✅ 多轮对话 + 流式输出
- ✅ `read_file`（读文件）/ `bash`（跑命令，30s timeout + cwd）
- ✅ GLM-5.2 经智谱 Anthropic 兼容端点
- ✅ 工具调用回流（LLM 调工具 → 看结果 → 继续回答）
- ⬜ TUI 界面（M2）/ `write_file`·`edit_file`·`ls`·`glob`·`grep`（M3）
- ⬜ 对话历史持久化（M4）/ 多 provider 切换 UI（M4）

> ⚠️ M1 的 bash **未做危险命令拦截**（留 M3），调用时自行留意（如 `rm -rf`）。

## 文档

权威设计见 [`docs/`](docs/README.md)：

- [MVP 详设 v6](docs/详设/2026-08-11_ECode-MVP详设_待审核.md) — 权威总览（架构 / 数据流 / 接口 / 错误处理 / 里程碑）
- [TUI 设计规范](docs/规范/2026-08-11_MVP-TUI设计规范_待审核.md) — 全屏框架式 + ActivityBar loading + 折叠 + 组件规格
- [技术栈选型解析](docs/解析/2026-08-11_MVP-技术栈选型解析_待审核.md) — ESM / Ink / grep / ls / JSON Schema 决策
- [配置系统与多 Provider 解析](docs/解析/2026-08-11_MVP-配置系统与多Provider解析_待审核.md) — JSONC / 两层 Provider / 双协议

工作区指令见 [`AGENTS.md`](AGENTS.md)。

## 项目结构

```
src/
  cli/         入口（readline REPL，TUI 留 M2）
  core/        心脏（loop / types 规范模型 / errors）
  providers/   LLMProvider（interface + registry + anthropic）
  tools/       工具（interface + registry 含 AJV / read_file / bash）
  services/    config / logger / history（stub，M3/M4 替换）
docs/          设计文档（大纲/详设/解析/诊断/决策/规范）
tests/         镜像 src（45 个单测）
scripts/       smoke.ts（真 LLM 烟测）
```

## 架构

```
              ┌──────────────────────────────────────┐
              │            AgentLoop（心脏）          │
              │   反复调 LLM → 执行工具 → 回喂，       │
              │   直到 LLM 不再要求工具                │
              └────────┬──────────────────────┬───────┘
                       │                      │
        ┌──────────────▼──────────┐  ┌────────▼──────────────┐
        │ LLMProvider Registry    │  │ Tool Registry         │
        │ (按 type·模型接入)      │  │ (含 AJV 校验·工具能力)│
        │ • AnthropicProvider     │  │ • read_file / bash    │
        │   → 接 GLM-5.2          │  │   (write/edit/... M3) │
        └─────────────────────────┘  └───────────────────────┘
```

**铁律**：心脏永不出现 `if provider === 'xxx'`——协议差异封在 Provider 实现内部。

## License

MIT
