# M6 阶段 E/F 实施方案（多渠道服务化 + Web + Repo Map 接入点 + 体验打磨）

> **里程碑**：M6 收尾里程碑的**阶段 E（多渠道）+ 阶段 F（Repo Map 接入点 + 体验打磨）**
> **定位**：本文件 = [M6-实施方案](./M6-实施方案[待实现].md) 阶段4/5 草案的**细化执行方案**。M6-实施方案 是整体规划权威源，本文件聚焦「阶段 E/F 具体怎么做」。
> **实施模式**：TDD（Red → Green → Refactor），分模块推进，每模块 `npm run build && npx vitest run` 全绿为检查点。
> **决策来源**：[decisions #004](../memory/decisions.md)（多渠道选型）+ [#005](../memory/decisions.md)（Repo Map 扩展化）+ 2026-08-10 用户拍板（见 §二）。
> **参考**：[OpenClaw 参考研究](../调研/20260806085241_OpenClaw参考研究[已完成].md)（Gateway+Channel 模式）+ openclaw 源码（github.com/openclaw/openclaw，TS/Node/pnpm）。
>
> **🔴 待最终确认**：E2 Web 技术栈（推荐 A，见 §五）、E1 两坑处理（§4.3）、F1 接口签名（§七）——用户审阅后定稿。

---

## 一、范围界定（做什么 / 不做什么）

### 1.1 阶段 E + F 做什么

| 阶段 | 模块 | 本期范围 |
|------|------|---------|
| **E1** | 服务化 Gateway | ✅ 本地 HTTP+WS（`node:http` + `ws`）+ session-router（自建锁）+ token 鉴权 + `127.0.0.1` |
| **E2** | Web 渠道 | ✅ 消费 `AgentEvent` 的 Web 前端（Vite+React+Tailwind，**待最终确认**），与 TUI 共享 `runAgentStream` |
| **E3** | 飞书渠道 | ⏸ **后置**——本期只留 channel adapter 接口；参考 `@openclaw/feishu`（WS 长连接免公网） |
| **F1** | Repo Map 接入点 | ✅ 核心「上下文增强」接入点 + `ContextProvider` 接口（零依赖 + NoOp 占位）；Repo Map 包后做 |
| **F2** | 体验打磨 | ✅ 角色 agent 审阅 + 自举（ECode 跑 ECode） |

### 1.2 不做（YAGNI / 红线）

- ❌ E3 飞书本体（后置，留接口）
- ❌ Repo Map 包本体（web-tree-sitter WASM + graphology，独立包后做，守 #005）
- ❌ Git 自动化（用户砍，2026-08-10）
- ❌ 多租户（不同用户连同一 Gateway）——单用户本地优先
- ❌ 公网暴露——默认 `127.0.0.1`（§9.2）
- ❌ daemon 分离进程——Gateway 与 TUI **同进程**（不像 openclaw daemon）

---

## 二、决策摘要（2026-08-10 用户拍板）

| 决策点 | 选项 | 定案 | 理由 |
|--------|------|------|------|
| **D2 阶段 E 范围** | A 仅服务化 / B 服务化+Web / C 全做 | **B（服务化+Web，飞书后置）** | openclaw「服务化是公共前提、channel 独立扩展」；Web 消费自家 WS 最自洽；飞书独立性强可后置 |
| **Repo Map 边界** | 接入点+接口 / MVP 包 / 仅文档 | **接入点+接口，包后做** | 守 #005；先埋扩展点零依赖，Repo Map 包后续做 |
| **F2 打磨方法** | 角色审阅 / 自举 / AI 找测试 | **角色审阅 + 自举** | 复用 M5 子代理（多视角）+ 实战暴露真实问题；不要 AI 找测试 |
| **后端框架** | hono / 原生 | **原生 `node:http` + `ws`** | 用户「node 生态」；ECode 手写哲学（不用框架）、KISS、§9.1 统一 npm |
| **E2 Web 技术栈** | A Vite+React / B 纯 HTML / C monorepo | **A（推荐，待最终确认）** | 渲染复杂度（markdown/折叠/审批）需 React 工程化；§9.3 原生二进制风险靠 Windows 侧构建规避 |

---

## 三、总体架构

借鉴 openclaw 的 **Gateway + Channel** 模式（见 [OpenClaw 参考研究](../调研/20260806085241_OpenClaw参考研究[已完成].md)），贴合 ECode 的**单进程、本地优先、手写**哲学：

```
┌──────────────────────────────────────────────────┐
│  ECode 单进程（ink TUI 仍是主入口，不变）           │
│                                                   │
│  ┌───────────┐         ┌────────────────────┐     │
│  │  ink TUI  │         │  Channel Gateway   │     │
│  │ (主入口)  │  共享   │  E1 · opt-in       │     │
│  │           │◄───────►│  node:http + ws    │     │
│  │           │         │  127.0.0.1:PORT    │     │
│  │  ┌────────┴─────────┴─────────┐          │     │
│  └──►   runAgentStream(task,opts) │ ◄─ 真相源 │     │
│      └─────────────┬──────────────┘          │     │
│                    │ WS（AgentEvent 流）       │     │
│      session-router(自建锁) + auth(token)     │     │
└────────────────────┼─────────────────────────┘
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   ┌─────────┐  ┌──────────┐  ┌──────────┐
   │ Web UI  │  │ 脚本/curl │  │飞书(后置)│
   │  E2     │  │          │  │   E3     │
   └─────────┘  └──────────┘  └──────────┘
```

**三条铁律**：

1. **单进程**：Gateway 与 ink TUI 同进程。TUI 主入口不变，Gateway 是 `channels.enabled` opt-in 的「额外口子」。不像 openclaw 用独立 daemon。
2. **共享 `runAgentStream`**：所有渠道（TUI/Web/飞书）消费同一个事件源（`src/agent.ts:291`，`AsyncGenerator<AgentEvent>`），前端只是渲染层。这是 openclaw 也遵循的「agent 是真相源」。
3. **本地优先**：默认 `127.0.0.1` + token 鉴权，不暴露公网（§9.2 / decisions #004 23-T7）。

### 3.1 现状红利（Explore 实测，2026-08-10）

服务端/Web 依赖**零基础**，但三个既有优势让服务化不是从零：

| 资产 | 现状 | 服务化复用 |
|------|------|-----------|
| `runAgentStream` | 已事件化（`AsyncGenerator<AgentEvent>`，`src/agent.ts:291`） | WS 直接 `for await` 消费 |
| tools 协议中立 | `ToolDefinition` = JSON Schema + 纯函数 `execute`（`src/tools/types.ts`） | 跨进程/跨 WS 只传 schema，execute 留服务端 |
| McpManager | 连接池 + `withLock` + `onChange` + `reload`（`src/mcp/manager.ts`） | session-router 锁 + WS 客户端管理同构 |
| `killProcessTree` | 进程树清理（`src/mcp/process-cleanup.ts`） | WS 客户端断连清理可直接复用 |

**两大坑**（§4.3 详述）：① `session.ts` 用 `cwd` 不用 `resolveDataDir` ② `permissionGate` 同步回调。

---

## 四、E1 服务化 Gateway

### 4.1 模块划分（`src/channels/`）

| 模块 | 职责 | 复用 |
|---|---|---|
| `server.ts` | `node:http` + `ws` 起服务，WS 端点 `/ws` + HTTP 端点（session list/resume） | McpManager 连接池/锁模式 |
| `ws-stream.ts` | WS ↔ `runAgentStream` 双向桥：入站消息 → 构造 opts → `for await event` → `ws.send(event)` | — |
| `session-router.ts` | 连接↔session 映射 + **自建串行锁**（同 session 绝不并发）+ 续接走 `ResumeContext` | `McpManager.withLock`、`session.ts` save/load/list |
| `auth.ts` | `verifyToken(token)`，token 启动生成写 `resolveDataDir/channels/token`（gitignore） | — |

### 4.2 接口设计

```ts
// src/channels/server.ts —— 本地 HTTP+WS 服务（原生 node:http + ws，不引入框架）
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';  // 待装依赖 ws@^8
import { resolveDataDir } from '../paths.js';

export function startChannelServer(opts: {
  port: number;
  host?: '127.0.0.1';        // 默认仅本地，硬安全网（23-T7）
  authToken: string;          // 连接鉴权 token
}): { close(): Promise<void> };
//  - WS 端点 /ws（对话流）+ HTTP 端点（会话管理：list/resume）
//  - 启动后 authToken 写入 resolveDataDir/channels/token（用户可改，gitignore）

// src/channels/ws-stream.ts —— AgentEvent → WS 推送（双向）
//  - 客户端发 { type:'message', sessionId?, prompt, authToken } →
//    服务端 runAgentStream(prompt, opts) → for await (event) → ws.send(event)
//  - 透传 AgentEvent（text_delta/tool_call_start/tool_result/permission_request/usage/completed/error）
//  - 权限 round-trip：推 permission_request → 收 { type:'permission_response', approved, toolUseId } → resolve

// src/channels/session-router.ts —— 连接 ↔ sessionId 映射（自建运行时映射 + 锁）
export function getOrCreateSession(connectionId: string): string;  // connectionId→sessionId Map
//  - 复用 session.ts saveSession/loadSession/listSessions（纯函数）
//  - 续接靠 agent.ts ResumeContext
//  - 每渠道连接独立 session（23-T4），多渠道不串话
//  - 🔴 并发锁（复用 McpManager.withLock 模式）：同 session 串行排队，绝不两个 runAgentStream 同 session 并发

// src/channels/auth.ts —— token 鉴权
export function verifyToken(token: string): boolean;
```

**WS 协议**：

```jsonc
// 客户端 → 服务端
{ "type": "message", "sessionId": "abc", "prompt": "帮我看看 src/", "authToken": "xxx" }
{ "type": "permission_response", "toolUseId": "toolu_1", "approved": true }

// 服务端 → 客户端（透传 AgentEvent）
{ "type": "text_delta", "text": "..." }
{ "type": "tool_call_start", "id": "toolu_1", "name": "read_file", "input": {...} }
{ "type": "tool_result", "id": "toolu_1", "content": "..." }
{ "type": "permission_request", "toolUseId": "toolu_1", "toolName": "bash", "input": {...}, "reason": "..." }
{ "type": "usage", "input": 123, "output": 456 }
{ "type": "completed", "sessionId": "abc" }
{ "type": "error", "message": "..." }
```

### 4.3 两坑处理（Explore 实测，关键技术决策）

**坑① `session.ts` 用 `cwd` 不用 `resolveDataDir`**（`src/session.ts:54` `defaultBaseDir = process.cwd()/.ecode/sessions`）

→ **决策：保持项目级语义，不改。**

- session 天然按项目隔离（一个项目的对话历史）。Gateway 跑在某个 cwd 下，多渠道/多连接共享**同一项目**的 session 池——cwd 语义正好匹配。
- 多租户（不同用户连同一 Gateway、不同项目）本期不做（YAGNI，单用户本地优先）。
- 与 `resolveDataDir`（`~/.ecode` 用户级，存 config/registry/skills）的区分**保持现状**：用户级配置 vs 项目级会话，职责清晰。

**坑② `permissionGate` 同步回调**（`src/agent.ts:147` `RunAgentStreamOptions.permissionGate`）

→ **决策：WS 路径改异步双向 round-trip；TUI 不受影响。**

- 现状：TUI 用 `permissionGate` 同步弹 `permission-dialog`（ink 同步交互），agent loop 内消费。
- WS 化后：客户端是远程的，审批必须 round-trip——服务端推 `permission_request` event → 客户端回 `permission_response` → 服务端 resolve。
- **实现**：
  - `ws-stream.ts` 维护 `Map<toolUseId, (decision: PermissionDecision) => void>`。
  - `permissionGate` 在 WS 路径返回一个 Promise，resolve 由入站 `permission_response` 触发。
  - 用一个**适配层**统一 TUI（同步/立即 resolve）与 WS（异步 round-trip）两种 gate，agent loop 不感知差异。
  - 超时降级：客户端 N 秒未回（IM/离线场景）→ deny 或预批准模式（呼应 #004 IM 审批妥协）。
- **这是 E1 服务化的必要接线**（不是顺手重构，不违反 §1.7）：没有异步 gate，WS 渠道无法承载工具审批。

### 4.4 安全接线

- 默认 `host: '127.0.0.1'`（硬安全网，不暴露公网，23-T7）。
- `authToken` 启动生成 + 写入 `resolveDataDir/channels/token`（用户可改，gitignore，§9.2）。
- 服务开关：config `channels.enabled`（**默认关**，opt-in）。
- `/channels` 命令（复用 `picker-list`，挂 `registerCommand`）：查看当前连接的渠道 + session（只读）。
- status-bar 可选显示「🌐 渠道服务 :PORT（N 连接）」。

### 4.5 TDD 步骤

- [ ] `server.test.ts`：起服务 + WS 连接 + 鉴权（token 错拒连）+ `127.0.0.1` 绑定
- [ ] `ws-stream.test.ts`：发 prompt → `runAgentStream`（mock provider）→ AgentEvent 透传；权限 round-trip（推 request → 收 response → resolve）
- [ ] `session-router.test.ts`：多连接独立 session；复用 `session.ts` save/load；**同 session 并发请求排队（锁）**；续接走 ResumeContext
- [ ] 集成：两个 WS 连接并发对话不串话

### 4.6 验收

- ✅ 起服务 → WS 连接（带 token）→ 发 prompt → 收 AgentEvent 流
- ✅ token 错拒连；非本机连不上（`127.0.0.1`）
- ✅ 多连接独立 session 不串话
- ✅ **同 session 并发请求排队**（绝不两个 runAgentStream 同 session 并发，session-router 锁验证）
- ✅ 权限 round-trip 通路（WS 客户端能批准/拒绝工具调用）
- ✅ 服务默认关（config opt-in）

---

## 五、E2 Web 渠道

### 5.1 内容（无论技术栈）

Web 前端连 E1 的 WS，消费 `AgentEvent` 渲染（移植 TUI 渲染逻辑）：

| 区块 | 消费事件 | 移植来源 |
|------|---------|---------|
| 对话窗口 | `text_delta`（markdown 流式） | TUI `markdown.tsx` |
| 工具折叠 | `tool_call_start` / `tool_result` | TUI `FOLD_STRATEGIES`（抽纯函数） |
| 审批弹窗 | `permission_request` | Web 版 `permission-dialog` |
| 状态栏 | 模型 / cost / ctx% / 渠道连接数 | TUI status-bar |
| 输入栏 | 发 prompt 到 WS；多行 / 斜杠 / @file 与 TUI 对齐 | — |

**关键**：Web 与 TUI **共享 `AgentEvent` 类型 + `runAgentStream`**，前端只是渲染渠道。TUI 渲染纯函数（markdown 解析、折叠策略）尽量抽成纯函数供 Web 复用。

### 5.2 技术栈选型（**推荐 A，待最终确认**）

Explore 实测 ECode 零 Web 依赖（仅 ink+react19，无 react-dom/vite）。CLAUDE.md §4.2 那套 React19+Zustand+shadcn+Tailwind v4+Vite 是**残留模板**（前端从 Vue 重构为 React 的历史遗留，本项目是 CLI 未真正用）。真正引入前三选项：

| 选项 | 栈 | 代价 | 评价 |
|---|---|---|---|
| **A（推荐）** | Vite + React + Tailwind，放项目内 `web/` 目录 | 引入构建链（esbuild/rollup 平台包，§9.3 风险）；靠「Windows 侧装依赖 + 构建」规避（已有经验） | 渲染复杂度需 React 工程化；最贴 openclaw Control UI；构建产物由 Gateway 静态托管 |
| B | 单 HTML + 原生 ESM + 浏览器原生 WebSocket | 零构建零依赖，零 §9.3 风险 | 失去 TS/JSX，渲染逻辑冗长；最克制但工程化弱 |
| C | Web 独立子工程（`apps/web` monorepo） | 与 CLI 解耦最干净 | ECode 当前单包，引入 workspace 是结构变更，过重 |

**推荐 A**：放项目内 `web/` 目录（**不 monorepo**，就是 src 同级的子目录 + 共用或独立 package.json），Vite 构建产物由 Gateway `node:http` 静态托管。Zustand store 按领域（chatStore/uiStore），与 TUI reducer 同源 AgentEvent。

> ⚠️ **§9.3 红线**：Vite 依赖 esbuild/rollup 平台原生包，Windows/WSL 混合环境会缺 `@rollup/rollup-linux-x64-gnu`。规避：**在 node_modules 安装侧（Windows）跑构建**，另一侧只做类型检查。已有 M6 阶段 B 经验。

### 5.3 TDD / 验收

- [ ] `web/` 连 WS → 发 prompt → 收 `text_delta` 流式渲染
- [ ] 工具折叠 / 审批弹窗正常
- [ ] 与 TUI 同一 session 续接（共享 session.ts）
- ✅ Web 能完整跑一轮对话（含工具调用 + 审批）

---

## 六、E3 飞书渠道（后置，本期只留接口）

本期**不做飞书本体**，只在 `src/channels/adapters/` 预留 channel adapter 接口。实施时参考 openclaw 飞书（[feishu.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md)）：

**openclaw 飞书关键模式（可直接借鉴）**：
- **WebSocket 长连接为默认**（免公网、无需隧道）→ 不与 ECode `127.0.0.1` 红线冲突，飞书渠道技术可行
- **流式 Card**：飞书 Card Kit streaming API，agent 边生成边更新卡片（映射 `runAgentStream` 的 `text_delta`）
- **会话作用域**：`group` / `group_sender` / `group_topic` / `group_topic_sender`（映射 session-router）
- **配对码审批**：陌生人 DM 需配对码（`dmPolicy: pairing`）
- **event ID 去重 + 持久化队列**：入站消息幂等
- 凭据：`appId` + `appSecret`（飞书开放平台），走独立注册表不进 config（§9.2）

**channel adapter 接口（本期定义，E3 后置实现）**：

```ts
// src/channels/adapters/types.ts —— 渠道适配器统一接口（E3 飞书/E4 其他 IM 都实现它）
export interface ChannelAdapter {
  name: string;                          // 'feishu' | 'web' | ...
  start(router: SessionRouter): Promise<void>;  // 启动渠道，接入 session-router
  stop(): Promise<void>;
}
```

> E2 Web 本质也走 WS，可作为 `ChannelAdapter` 的一个实现（或独立，实施时定）。

---

## 七、F1 Repo Map 接入点（核心包，零依赖，包后做）

Explore 实测：「上下文增强」接入点**零代码零接口**（`src/context-manager.ts` 是上下文**压缩**器，非增强）。本期只埋扩展点，守 [decisions #005](../memory/decisions.md)。

### 7.1 接口设计

```ts
// src/context-enhancer/types.ts —— 扩展接口（本期只定义 + NoOp 占位，零依赖）
export interface EnhanceContext {
  cwd: string;                  // 项目根
  mentionedFiles: string[];     // 用户 mention 的文件（种子）
  tokenBudget: number;          // 上下文预算（增强内容裁剪上限）
}

export interface EnhanceResult {
  content: string;              // 注入 system/上下文的增强内容（repo map/符号表等）
  source: string;               // 来源标识（'repomap' | 'noop' | ...）
}

export interface ContextProvider {
  name: string;
  /** 按预算返回要注入的增强内容；无则 null。 */
  enhance(ctx: EnhanceContext): Promise<EnhanceResult | null>;
}
```

### 7.2 接入点

- **注入位**：`src/system-prompt.ts`（catalog 注入的现成位置）+ `src/agent.ts:308-315`（catalog 拼接 system 处）增加 context-enhancer 注入 hook。
- **注册**：仿 skills loader——扫 `resolveDataDir` 下已安装的 enhancer 包（动态 `import()`），未装则内置 `NoOpProvider`（返回 null）。

### 7.3 本期范围 vs 后做

| 范围 | 本期（F1） | 后做（Repo Map 包） |
|------|-----------|-------------------|
| 接口 | ✅ `ContextProvider` + `EnhanceContext/Result` | — |
| 接入点 | ✅ system-prompt 注入 hook + 注册机制 | — |
| 占位 | ✅ `NoOpProvider`（返回 null） | — |
| Repo Map 本体 | ❌ | ✅ 实现 `ContextProvider`：web-tree-sitter WASM + graphology PageRank + 纯 JS 缓存（守 #005/§9.3） |
| grammar | ❌ | ✅ 起步 5-7 门（JS/TS/Python/Go/Rust/Java），缺失优雅降级 |

**YAGNI**：本期不实现 Repo Map 本体，只埋扩展点。独立 npm 包后续做。

---

## 八、F2 体验打磨（角色 agent 审阅 + 自举）

### 8.1 方法 1 · 角色 agent 审阅（复用 M5 子代理）

派多个 subagent 各扮一个角色审阅 ECode 自身，各出**可执行改进清单**（issue 级）：

| 角色 | 审阅维度 |
|------|---------|
| **产品经理** | 交互路径、易用性、文档、新用户上手 |
| **架构师** | 模块边界、耦合、扩展性、技术债 |
| **新手用户** | 按 README 走一遍，记录每个卡点 |

**实现**：
- `npm run review`（或斜杠命令 `/review`）→ 调 `runAgentStream` **子代理模式**（[M5 子代理](./M5-实施方案[已完成].md)）：
  - system 注入角色人设 + 审阅任务描述
  - tools 子集 = 只读（read/grep/glob/ls）+ 权限⊆（收紧，不能改文件）
  - 每个角色独立 session，产出结论
- 复用 M5 子代理（`runAgentStream` 递归 + 权限⊆ + 防递归深度）。

### 8.2 方法 2 · 自举（ECode 跑 ECode）

用 ECode 在自己仓库干活——修 bug、加测试、补文档、跑 CI 修复。

- **目的**：实战暴露体验与能力缺口（哪些工具不好用、哪些 prompt 不清晰、哪些 edge case 崩）。
- **实现**：无需额外代码（就是正常 `npm run dev -- "帮我在 src/xxx 加测试"`），是「刻意用它开发它自己」的工作流。
- **产出**：使用日志 + 发现的问题清单。

### 8.3 组合

```
自举（方法 2）发现真实问题 ──► 角色 agent 审阅（方法 1）系统梳理 ──► 改进 backlog ──► 逐项修
```

自举提供真实痛点素材，角色审阅提供系统性视角，两者互补。

---

## 九、阶段拆分与依赖

```
E1 服务化 ──┬─► E2 Web（依赖 E1 的 WS + AgentEvent）
            └─► E3 飞书（后置，依赖 E1 + adapter 接口）

F1 Repo Map 接入点 ── 独立，可与 E 并行（零依赖，只埋接口）
F2 体验打磨（角色+自举）── 独立，可与 E 并行（复用 M5 子代理）
```

**建议顺序**：**E1 → E2 →（F1/F2 与 E 并行或收尾）**。E3 飞书本期不做、留接口。

| 阶段 | 依赖 | 预估 |
|------|------|------|
| E1 服务化 | 无（复用 runAgentStream + McpManager 模式） | 最大（含 permissionGate 异步接线） |
| E2 Web | E1（WS + AgentEvent） | 中（引入 Web 栈 + §9.3 规避） |
| F1 接入点 | 无 | 小（接口 + NoOp） |
| F2 打磨 | M5 子代理（已落地） | 中（角色 prompt 调优 + 自举迭代） |

---

## 十、权限 / 安全接线

| 模块 | 安全点 | 接线 |
|------|--------|------|
| E1 | 服务不暴露公网 | 默认 `127.0.0.1`（23-T7） |
| E1 | 连接鉴权 | `authToken`（启动生成，gitignore） |
| E1 | 同 session 并发 | session-router 自建锁（绝不并发） |
| E1 | 权限审批 | WS round-trip + 超时降级 deny/预批准 |
| E2 | Web 同源/凭证 | Web 静态资源由 Gateway 托管，token 走 WS 首包 |
| E3 | 渠道凭证独立 | bot secret 走独立注册表，不进 config（§9.2） |
| F1 | 增强内容不泄密 | ContextProvider 只读文件，注入内容过 system（无额外权限） |
| F2 | 角色 agent 只读 | tools 子集 + 权限⊆（不能改文件） |

---

## 十一、测试策略

### 11.1 单元测试

| 模块 | 测试重点 |
|------|----------|
| `channels/server.ts` | WS 连接、鉴权、`127.0.0.1` 绑定 |
| `channels/ws-stream.ts` | AgentEvent 透传、权限 round-trip |
| `channels/session-router.ts` | 多连接独立 session、同 session 并发排队锁、续接 |
| `channels/auth.ts` | token 校验、token 文件读写 |
| `channels/adapters/types.ts` | ChannelAdapter 接口契约 |
| `context-enhancer/types.ts` | ContextProvider 接口、NoOp 返回 null |
| `context-enhancer/registry.ts` | enhancer 注册/扫描、未装降级 NoOp |

### 11.2 集成测试

| 场景 | 验证点 |
|------|--------|
| 多渠道并发 | 两 WS 连接不串话 |
| 渠道鉴权 | token 错拒连、非本机不上 |
| 权限 round-trip | WS 客户端批准/拒绝工具调用 |
| Web 端到端 | Web 发 prompt → 流式渲染 → 工具折叠 → 审批 |
| 接入点注入 | NoOp 不影响现有 system prompt（零回归） |
| 角色审阅 | `/review` 派子代理 → 产出结构化清单 |

---

## 十二、YAGNI 不做清单（明确推后）

- ❌ E3 飞书本体（后置，留接口）
- ❌ Repo Map 包本体（独立包后做）
- ❌ Git 自动化（用户砍）
- ❌ 多租户 / 多项目同 Gateway（单用户本地）
- ❌ 公网暴露 / daemon 分离
- ❌ IM 全平台同做（按需接，飞书优先）
- ❌ Web 全功能对齐 TUI（先核心，增强后置）
- ❌ hono 等框架（用原生 node:http + ws）

---

## 十三、验收标准（阶段 E + F 完成）

- [ ] **E1 服务化**：本地 HTTP+WS + 会话路由（自建锁）+ 鉴权 + 多连接不串话 + 权限 round-trip
- [ ] **E2 Web**：Web 连 WS 跑完整对话（流式 + 工具折叠 + 审批），共享 `runAgentStream`
- [ ] **E3 接口**：`ChannelAdapter` 接口定义 + 文档（飞书本体后置）
- [ ] **F1 接入点**：`ContextProvider` 接口 + system 注入 hook + NoOp（零回归）
- [ ] **F2 打磨**：`/review` 角色 agent + 自举工作流跑通，产出改进 backlog
- [ ] **质量**：单元测试覆盖 > 85%；集成场景全过；`npm run build && npx vitest run` 全绿
- [ ] **红线**：新增依赖无原生二进制冲突（§9.3）；Web 栈在 Windows 侧构建；凭证不进 config/log（§9.2）

---

## 关联

- 整体规划权威源：[M6-实施方案](./M6-实施方案[待实现].md)（阶段4/5 草案，本文件细化它）
- 选型理由：[M6-技术选型与理由](./M6-技术选型与理由[待实现].md)
- 决策记录：[decisions #004](../memory/decisions.md)（多渠道）/ [#005](../memory/decisions.md)（Repo Map 扩展化）
- openclaw 参考：[OpenClaw 参考研究](../调研/20260806085241_OpenClaw参考研究[已完成].md) + [飞书渠道文档](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md)
- 现状实测：2026-08-10 Explore agent 调研（`src/agent.ts:291` runAgentStream / `src/mcp/manager.ts` McpManager / `src/session.ts:54` cwd / `src/paths.ts:20` resolveDataDir）
- M5 子代理（F2 复用）：[M5-实施方案](./M5-实施方案[已完成].md)

---

**创建日期**：2026-08-10
**状态**：待用户审阅（E2 技术栈 / 两坑处理 / F1 接口签名 待最终确认）
**下一步**：① 用户审阅本方案 → 定稿待确认项；② 按 §九 顺序实施（E1 起步）。
