# ECode

> 终端 Agent CLI —— 以 **AgentLoop 为心脏**，工具 / 模型接入 / TUI / 历史 / 配置作为分支接入心脏。形态对标 Claude Code / Aider。
>
> 技术栈：TypeScript 严格模式 · Node.js · Ink（TUI）· Anthropic/OpenAI 双协议接入

## 现状

功能以「能力清单」为准（命令清单运行 `/help`，配置权威见内置 `ecode-config` skill）：

- **交互**：Ink TUI 多轮对话 + 流式输出 + 插话（busy 态发消息排队）；20+ 斜杠命令（以 `/help` 为准——勿在此硬编码计数）；快捷键 Ctrl+T（详情统一入口两级菜单）/Ctrl+R（历史）/Tab（沙箱循环）等
- **工具面**：读/写/编辑/ls/glob/grep/bash（危险命令拦截+沙箱五档）/web 搜索与抓取/子代理（task）/后台任务/任务清单（todo）/Skill 与 MCP 扩展/Plugin
- **记忆与上下文**：会话历史持久化+恢复（/history /rewind）· ECODE.md 两级指令注入 · MEMORY.md 自动记忆 · 上下文压缩（/compact，分批 map-reduce）
- **质量与安全**：lint/test 编辑后回喂自纠 · loopGuard 三检测器（复读/同参同果/连续空错自动止损）· 纠偏审查（review 高级模型定时+异常信号出卡）· 审批挂起超时 · settings 三层权限
- **多端**：`ecode serve` Web/PWA（daemon 多项目）· 飞书 IM · 微信 ClawBot · relay 异地中继 · 设备配对
- **成本**：token/费用四维统计（/stats /cost）· 缓存命中率 · 压缩省账

设计文档齐全（[`docs/`](docs/README.md)），测试与里程碑实施记录随文档体系维护。

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

## 文档

**长文内容以 docs 体系为准，本 README 只做入口**（避免长文漂移——历史教训见 docs/README.md）：

- [docs/README.md](docs/README.md) — 文档索引（详设/规范/解析/诊断总入口）
- [MVP 详设 v6](docs/详设/2026-08-11_ECode-MVP详设_待审核.md) — 权威总览（架构 / 数据流 / 接口 / 错误处理 / 里程碑）
- [活文档清单与同步守则](docs/规范/2026-08-16_活文档清单与同步守则_已完成.md) — 哪些文档何时必须同步
- 配置怎么配：问内置 `ecode-config` skill（模型自动加载）或读 `src/services/config.ts` 的 CONFIG_TEMPLATE

工作区指令见 [`AGENTS.md`](AGENTS.md)。

## 项目结构

```
src/
  cli/         入口（args 解析/装配/serve 主循环）
  core/        心脏（loop / system 提示词 / types 规范模型 / errors）
  providers/   LLMProvider（anthropic/openai 双协议 + 翻译层 + 看门狗）
  tools/       工具（interface + registry 含 AJV / builtin 全家桶）
  host/        宿主会话（HostSession：审批/压缩/loopGuard/多会话）
  commands/    斜杠命令注册表（/help 动态列）
  services/    config / history / skill / mcp / hooks / tasks / stats ...
  tui/         Ink 组件与面板
web/           Web 前端（Vite + React，serve 托管）
docs/          设计文档（大纲/详设/解析/诊断/决策/规范）
tests/         镜像 src（vitest，1900+ 用例）
scripts/       探针与烟测脚本
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
        │ (双协议·模型接入)        │  │ (AJV 校验·沙箱·审批)  │
        └─────────────────────────┘  └───────────────────────┘
```

**铁律**：心脏永不出现 `if provider === 'xxx'`——协议差异封在 Provider 实现内部。

## License

MIT
