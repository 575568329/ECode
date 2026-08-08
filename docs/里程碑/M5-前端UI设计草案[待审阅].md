# M5 前端 UI 设计草案（待角色审阅）

> **生成**：2026-08-09。基于双源调研（CC `D:\Study\claude-code-main` + opencode `D:\Study\opencode`）+ ECode 现有 UI 源码审计（`src/ui/`）。
> **状态**：✅ 角色审阅**完成**（2026-08-09 二轮：架构师 + CC/MCP 专家）。**审阅改定见下方横幅**；详情见 [问题清单 · UI 审阅节](./M5-文档审阅问题清单[待审阅].md)。
> **决策点**：原默认 C/A/B/B。**审阅后决策①④ 降级保黑盒（见横幅），待用户确认**；②③ 维持推荐 A/B。
> **背景**：M5 三文档此前只设计后端架构，缺前端 UI 设计。本草案补齐。

---

> ## ⚠️ 审阅改定（2026-08-09，待用户确认）
> **架构冲突**：本草案的子代理/hook 进度事件（`subagent_progress` / `hook_progress`）与 [实施方案 §1.1/§八](./M5-实施方案[待实现].md)「子代理黑盒」**冲突**。
>
> **决策①④ 降级**（保 M5 黑盒，不加新事件）：
> - **① 子代理进度块**：M5 保持黑盒（**无 `subagent_progress` 事件**），实时可观测推 **M6+**。下文 §二「AgentEvent 加 subagent_*」「chat-view 子代理进度块」「`subagent_result` kind」**以本注为准，推 M6+ 或删除**。
> - **④ hook 运行时显示**：**A 全静默**（仅 `--debug`）。下文 §四「`hook_progress` 事件」「chat-view hook 运行时行」**以本注为准**；hook 拒绝复用现有 deny / ToolDone 反馈。
>
> **修正项**（已并入下文）：McpPanel 5 态图标 typo（`○` 重复 → 4 图标 5 态）；FOLD `mcp__` 前缀分支（动态工具名精确查失效）；MCP prompt 触发口径「双源共识」→「CC 单源路径」。
>
> 详见 [问题清单 · UI 审阅节](./M5-文档审阅问题清单[待审阅].md)。**降级待用户审阅确认**——确认前，下文相关段落保留原设计思路（供 M6+ 实时可观测参考），但 M5 实施按黑盒走。

---

## 一、扩展性总评：ECode > CC/opencode

**核心发现**：CC/opencode 是「每支点写专门大组件」（CC 子代理 UI `AgentTool/UI.tsx` 872 行、MCP `MCPListPanel.tsx`）。ECode 走**声明式表 + 通用积木**，M5 的扩展点基本现成，多数是「加一行/加一个分支」。

| M5 需求 | ECode 现成扩展点 | 文件:行 | 改动量 |
|---|---|---|---|
| MCP 工具折叠 | `FOLD_STRATEGIES` 声明式表 | tool-panel.tsx:60-76 | 1 行 |
| MCP prompt 斜杠识别 | `SLASH_COMMANDS` 声明式数组 | slash-commands.ts:14 | 1 行 |
| MCP 工具审批 | 通用 `PermissionDialog` | permission-dialog.tsx | 加 `(MCP)` 灰标 |
| /mcp、/hooks 面板 | 通用 `PickerList`（twoLine） | picker-list.tsx | 复用 |
| 子代理/hook 事件分流 | 纯函数 `reduceAgentEvent` | reduce-agent-event.ts | 加 case |

> 这是 M3.5 架构红利：工具折叠、斜杠、picker、权限都做成了声明式/通用件，M5 直接挂。**结论：ECode 的 M5 前端总成本远低于 CC/opencode。**

---

## 二、支点 9 子代理 UI

### 复用
- `ToolRunning`（spinner）+ `FOLD_STRATEGIES`（加 `'subagent'` 行）
- `PermissionDialog`：A 方案子代理权限请求走现有 `permission_request` 事件 → **零改动**
- `StatusBar`：后台子代理徽标

### 新增
- `AgentEvent` 加 `subagent_progress` / `subagent_complete`（agent-events.ts）
- `reduceAgentEvent` 加分支（子代理进度归组）
- `chat-view` 动态区：子代理活跃时显示进度块
- `DisplayMessage` 加 `subagent_result` kind（完成回喂 `Done (N tool uses · M tokens · duration)`）

### 🔴 决策点①——进度块形态（**推荐 C**）
- A. CC 树形（最后 3 条 progress + Ctrl+O 展开）——信息密，实现重
- B. opencode 单行（`↳ current tool`）——极简但黑盒
- **C. 折中：单行实时 `↳ current tool` + Ctrl+O pager 看完整（ECode 已有 pager 基建）** ← 推荐：简单且有逃生舱

---

## 三、支点 10 MCP UI

### 复用
- `PickerList`（twoLine）→ `/mcp` 面板
- `PermissionDialog`（MCP 工具审批，加 `(MCP)` 灰标，改 `summarize`）
- `FOLD_STRATEGIES`（MCP 工具兜底 `head(3)` 已够，特殊 server 按需加行）
- `StatusBar`：加 `⊙ N MCP` 徽标（采纳 opencode 做法，CC「必须 /mcp 才能看」对用户不友好）
- `input-bar` candidates：合并 MCP prompts（带 `:mcp` 标记）

### 新增
- `McpPanel` 新组件（5 态图标 `✓`/`○`/`▲`/`✗`/`○` + scope 分组 + 子命令 reconnect/enable/disable）
- `permission-dialog` 的 `summarize()` 加分流：MCP 工具名后追灰标 `(MCP)`（对齐 CC `FallbackPermissionRequest.tsx:251-256`）
- `slash-commands.ts`：`SlashCommandDef` 加 `source` 字段 + 放开动态命令识别（= 实施方案的「斜杠重构先决条件」）
- MCP 首次发现审批（三选项 yes_all/yes/no，对齐 CC `MCPServerApprovalDialog.tsx`）

### 🔴 决策点②——MCP prompt 触发（**推荐 A**）
- **A. 进 `SLASH_COMMANDS` 但标 `source:'mcp'`**——typeahead 自动有，`parseUserInput` 统一识别，执行时内置走 switch、MCP 走 prompt adapter ← 推荐（对齐实施方案斜杠重构）
- B. 独立 typeahead 源（标记 `:mcp`，不进注册表）

### 🔴 决策点③——/mcp 面板深浅（**推荐 B**）
- A. opencode 极简（只列状态+开关）
- **B. scope 分组 + 5 态图标 + 基础子命令（开关/重连）** ← 推荐：介于两源之间，够用

---

## 四、支点 12 Hooks UI

### 复用
- `chat-view` 动态区：hook 运行时显示 `Running <Event> hook…`
- `PermissionDialog` deny 路径：hook deny 复用（已有 warning/error kind）
- `StatusBar`：hook 运行态（可选）
- `PickerList`：`/hooks` 只读面板

### 新增
- `AgentEvent` 加 `hook_progress` 事件
- `reduceAgentEvent` 加分支（PreToolUse/PostToolUse 默认静默，其他事件显示一行，完成消失）
- `HooksPanel` 新组件（4 层只读浏览：event → matcher → hook → detail，对齐 CC `HooksConfigMenu.tsx`）
- `handleCommand` 加 `'hooks'` case

### 🔴 决策点④——hook 运行时显示粒度（**推荐 B**）
- A. 全静默（只 `--debug` 看）
- **B. CC 折中：SessionStart/Stop/Notification 显示一行，PreToolUse/PostToolUse 默认静默，拦住时走 deny 反馈** ← 推荐

---

## 五、改动文件清单（~475 行）

| 支点 | 文件 | 改动 | ~行 |
|---|---|---|---|
| 跨 | agent-events.ts | 加 subagent_*/hook_progress 事件 | 40 |
| 跨 | reduce-agent-event.ts | 加分支 | 60 |
| 跨 | types.ts | DisplayMessage 加 subagent_result | 15 |
| 9 | chat-view.tsx | 子代理进度块 | 50 |
| 10 | mcp-panel.tsx（新） | /mcp 面板 | 120 |
| 10 | permission-dialog.tsx | summarize 加 (MCP) | 10 |
| 10 | status-bar.tsx | ⊙ N MCP 徽标 | 15 |
| 10 | input-bar.tsx | candidates 合并 MCP prompts | 20 |
| 10 | slash-commands.ts | source 字段 + 动态识别 | 25 |
| 12 | hooks-panel.tsx（新） | /hooks 面板 | 100 |
| 12 | chat-view.tsx | hook 运行时行 | 20 |

> 对比 CC 子代理单组件 872 行——ECode 因解耦，总成本可控。

---

## 六、与后端架构的衔接

- **子代理**：后端递归 `runAgentStream` 产出 `subagent_progress`/`subagent_complete` 事件 → `reduceAgentEvent` 分流 → UI 进度块。权限继承 A 方案（共享主 AllowList）→ 子代理 `permission_request` 复用现有事件，UI 零改动。
- **MCP**：后端 MCP client 暴露 prompts 列表 → 启动时注入 `SLASH_COMMANDS`（source='mcp'）→ typeahead + 执行分流（prompt adapter）。MCP 工具调用走标准 tool 事件流，UI 复用 ToolRunning/ToolDone。
- **Hooks**：后端 hook 执行器产出 `hook_progress` 事件 → `reduceAgentEvent` 分流（Pre/Post 静默、其他显示）→ UI 运行时行。hook deny 汇入 permission result → 复用 warning/error kind。

---

> **审阅请聚焦**：① 扩展性总评是否成立（ECode 解耦是否真能省这么多）② 4 决策点推荐是否合理 ③ 改动清单有无遗漏 ④ 与后端架构（M5 三文档）的衔接是否自洽 ⑤ 有无臆测/精度问题（附 file:line 证据）。
