# M3.5 阶段②：Ink REPL 交互式终端 UI 设计规格

> **前置**：阶段①（agent core 事件化）已完成，`runAgentStream` 产出 `AsyncGenerator<AgentEvent>` 事件流。
> **参考实现**：CCode（npm Ink 6 + React 19，源码 `D:\Study\CCode\cCli\src\ui\`）、Claude Code（自研 Ink fork + React Compiler，5005 行 REPL.tsx）。
> **依赖验证**：Ink 7.1.1 + React 19.2.8 + Node 22.22.2 + tsx 在 Windows 跑通 hello world ✅。

---

## 1. 目标

把 ECode 从「one-shot CLI」升级为「交互式 REPL」，用户 `ecode`（无参 + TTY）进入沉浸式终端 UI，实时消费 `runAgentStream` 事件流渲染对话。

保留 one-shot 模式：`ecode "任务"` 或非 TTY 环境走现有 `runAgent` wrapper。

---

## 2. 技术栈

| 包 | 用途 | 版本 |
|----|------|------|
| `ink` | REPL 渲染框架 | ^7.1（验证通过） |
| `react` | 组件模型 | ^19.2（验证通过） |
| `tsx` | TSX 运行时（开发） | 开发依赖 |
| `marked` | Markdown 解析 | 待定 |
| `cli-highlight` | 代码高亮 | 待定 |

**注意**：实施方案写的是 Ink 6，实际验证 Ink 7 可用。Ink 7 是最新版，API 向后兼容。

---

## 3. 架构

### 3.1 文件结构

```
src/ui/
  index.ts              — 导出 App + render 入口
  App.tsx               — REPL 主体（组合所有子组件）
  useAgentStream.ts     — 核心 hook：桥接 runAgentStream ↔ React state
  ChatView.tsx          — 消息渲染（<Static> 冻结历史 + 动态流式区）
  InputBar.tsx           — 单行输入 + 历史 + Tab 补全
  PermissionDialog.tsx  — dangerous 工具审批弹窗
  ToolPanel.tsx          — 工具执行可视化（spinner + 计时 + 结果预览）
  MarkdownRenderer.tsx   — marked + cli-highlight 渲染
  types.ts              — UI 层类型定义
```

### 3.2 组件树

```
App
├─ WelcomeScreen（未开始时）
├─ ChatView（started 后）
│   ├─ <Static items={completedMessages}>  ← 冻结已完成消息
│   └─ 动态区
│       ├─ streamingText（流式文本）
│       ├─ activeTools[]（运行中工具）
│       └─ error（错误信息）
├─ PermissionDialog（pendingPermission 时替换 InputBar）
├─ InputBar（默认底部）
└─ StatusBar（可选）
```

### 3.3 事件流

```
runAgentStream(task, opts)
  ↓ AsyncGenerator<AgentEvent>
useAgentStream hook
  ↓ for await + React setState
React 组件树
  ↓ <Static> + 动态渲染
终端输出
```

---

## 4. 核心设计模式（借鉴 CCode 源码研究）

### 4.1 `<Static>` 冻结历史（CCode ChatView.tsx）

已完成消息通过 `<Static items={completedMessages}>` 渲染后冻结到 stdout，Ink 不会重新 diff 它们。长对话渲染成本 O(n) → O(1)。动态区只渲染流式文本 + 运行中工具（固定大小）。

每条消息需稳定 `key`（UUID 或序号）。

### 4.2 Modal 替换而非叠加（CCode App.tsx）

`pendingPermission` 存在时，InputBar 卸载，PermissionDialog 挂载。ternary 链式条件渲染，同一时间只有一个 `useInput` 活跃组件。避免 focus 竞争。

### 4.3 双 state + ref（CCode useChat.ts）

每个 async closure 里读取的值同时维护 `useState`（驱动渲染）和 `useRef`（闭包内读最新值）。如 `isStreaming` + `isStreamingRef`。

### 4.4 Generation 计数器防竞态（CCode useChat.ts）

每次 `submit` 递增 `generationRef`。`finally` 块只在 `generationRef.current === generation` 时清理 `isStreaming`。防止 abort loop A 后启动 loop B，A 的 finally 覆盖 B 的状态。

### 4.5 权限双通道（ECode 特有）

CCode 在 yield 事件里传 `resolve` 函数。ECode 已有更优设计：
- `permission_request` 事件（可观测，告诉 UI 显示什么）
- `PermissionGate.ask()` 回调（决策通道，返回 Promise）

hook 内部创建 `PermissionGate` 实现：
```ts
let resolvePermission!: (decision: 'allow' | 'deny') => void;
const gate: PermissionGate = {
  ask: () => new Promise((resolve) => { resolvePermission = resolve; })
};
```
UI 看到 `permission_request` 事件 → 显示 PermissionDialog → 用户点击 → resolve Promise → `runAgentStream` 继续。

注意：ECode 当前 `PermissionGate.ask()` 签名返回 `Promise<'allow' | 'deny'>`，需扩展支持 `'allow_always'`。或在 hook 内部处理：`allow_always` → 调 `allow.add(toolName)` 后 resolve `'allow'`。

### 4.6 双击 Ctrl+C 退出（CCode App.tsx）

2000ms 窗口：
- 第一次 Ctrl+C：如果 streaming → abort + 提示"再按退出"；否则 → 提示"再按退出"
- 第二次（2000ms 内）：`process.exit(0)`

---

## 5. 组件规格

### 5.1 useAgentStream hook

```ts
interface UseAgentStreamReturn {
  completedMessages: DisplayMessage[];
  streamingText: string | null;
  activeTools: ActiveTool[];
  pendingPermission: PendingPermission | null;
  isRunning: boolean;
  error: string | null;
  submit: (text: string) => void;
  resolvePermission: (decision: 'allow' | 'deny' | 'allow_always') => void;
  abort: () => void;
}
```

**submit 流程**：
1. `generationRef.current++`（防竞态）
2. 把用户消息加入 `completedMessages`
3. 创建 `AbortController`
4. 启动 async IIFE：`for await (const event of runAgentStream(task, { signal, system, permissionGate, allow }))` → 按 event.type 更新 state
5. `text_delta` → 追加到 `streamingText`
6. `tool_call_start` → 追加到 `activeTools`
7. `tool_result` → 从 `activeTools` 移除，追加到 `completedMessages`
8. `permission_request` → 设置 `pendingPermission`（UI 显示弹窗）
9. `warning` / `error` → 追加 system message
10. `completed` → 把 `streamingText` 转为 completedMessage，清空 `streamingText`
11. finally：generation 匹配时清理 `isRunning`

**UI state ≠ LLM history**（CCode 关键教训）：`DisplayMessage[]` 是渲染用数据结构。LLM 的消息历史在 `runAgentStream` 内部管理，不经过 UI。禁止从 UI state 重建 LLM history。

### 5.2 App.tsx

**职责**：
- 组合 ChatView / InputBar / PermissionDialog / WelcomeScreen
- 斜杠命令 dispatch（CommandRegistry 模式）
- 全局按键处理（Ctrl+C、Esc）
- Tab 补全浮层

**斜杠命令**（8 个，阶段①已定义 4 个 + 新增 4 个）：

| 命令 | 执行逻辑 |
|------|---------|
| `/help` | 显示命令列表 |
| `/clear` | 清空 `completedMessages` |
| `/model <name>` | 切换模型 |
| `/exit` | `process.exit(0)` |
| `/cost` | 显示当前会话 token 用量 |
| `/compact` | 手动触发上下文压缩 |
| `/resume` | 显示会话恢复面板 |
| `/sessions` | 列出项目会话 |

### 5.3 InputBar

- **L2 单行**（不用 ink-multiline-input，实施方案选定）
- `↑`/`↓` 翻阅历史（`historyIndex = -1` 为草稿）
- Tab 补全由 App 层 `useInput({ isActive: suggestions.length > 0 })` 处理
- `streaming` 时不渲染（或显示 "Esc to interrupt"）
- Enter → `onSubmit(text)`

**暂不做**（YAGNI）：
- `ink-multiline-input`（不成熟，实施方案明确排除）
- `@` 文件引用（CCode 有，ECode 留后续）
- Home/End/Delete Windows scan code 处理（留 M4）

### 5.4 PermissionDialog

**三选项**：Yes / Yes, and don't ask again / No

显示内容：
- 工具名 + 参数摘要
- bash → 命令文本
- edit_file/write_file → diff 预览（读当前文件对比）

按键：`↑`/`↓` 选选项，Enter 确认，Esc = No

**Yes, and don't ask again 行为**：
- 调用 `allowList.add(toolName)`（session 级内存 Set）
- 后续同一工具不再询问（`shouldAsk` 返回 false）

### 5.5 ToolPanel

**三态渲染**（借鉴 CCode ToolStatusLine.tsx）：

| 状态 | 显示 |
|------|------|
| Running | `<Spinner>` + 工具名 + 参数摘要 + 计时（≥3s 后显示） |
| Done | ✅ 工具名 + 耗时 + 输出预览（前 4 行 + ⎿ 折叠提示） |
| Error | ❌ + 错误摘要 |

**meta 驱动渲染**：
- `bash` → 执行的命令文本
- `read_file` → 路径 + 行数
- `edit_file` → diff（red/green 行）
- `write_file` → 路径 + 行数
- 其他 → 工具名 + 参数摘要

### 5.6 MarkdownRenderer

**渲染策略**（避免流式抖动）：
- 流式期：纯 `<Text>` 输出（逐字追加）
- `completed` 后：`marked` 解析 + `cli-highlight` 代码高亮 full render

**支持范围**（YAGNI，只做最常用的）：
- 代码块（带语言标记 → 语法高亮 + 背景色）
- 行内代码
- 标题、粗体、斜体
- 列表（有序 + 无序）
- 链接（显示 URL 文本）
- 表格（基础对齐）

暂不做：脚注、任务列表 checkbox、数学公式、图片。

### 5.7 双模式入口（index.ts 改造）

```ts
if (!process.stdin.isTTY || positionals.length > 0) {
  // one-shot / pipe 模式：走现有 runAgent
  runAgent(task, values.model, { signal, system }).catch(...)
} else {
  // REPL 模式：启动 Ink
  // 注意：render 是同步的，后面的代码不会执行
  // 清理逻辑通过 process.on('exit') 处理
  const { render } = await import('./ui/index.js');
  render(React.createElement(App, { model: values.model, cwd: process.cwd() }))
}
```

---

## 6. 依赖新增

| 包 | 用途 | 备注 |
|----|------|------|
| `ink` | REPL 渲染 | ^7.1，已验证 |
| `react` | 组件模型 | ^19.2，已验证 |
| `marked` | Markdown 解析 | light |
| `cli-highlight` | 代码高亮 | light |

**不做**：`ink-text-input`（CCode 用但大量自研补丁）、`ink-spinner`（Ink 7 自带或极简实现）。

---

## 7. 补充研究发现（实施计划参考）

以下模式来自阶段①完成后对 CCode / Crush / ivanleo / Claude Code 源码的深入研究。在编写实施计划时融入 spec。

### 7.1 核心模式补充

| 模式 | 来源 | 说明 | 实施建议 |
|------|------|------|---------|
| **Prefix-cache streaming markdown** | Crush `streaming_markdown.go` | 比 CC 的两组件 swap（forgiving→strict）更优雅。缓存已渲染的稳定前缀（找到最后一个安全 markdown 边界：无未闭合代码块/列表标记），每 tick 只重渲染尾部增量。避免 swap 闪烁，单一渲染器。 | MarkdownRenderer 流式期采用此方案，而非简单的"流式纯文本 / completed 后 full render"两组件 swap |
| **Dialog grace period** | Crush `dialog.go`，425ms/1500ms | 弹窗弹出时吸收从之前焦点组件残留的按键事件，防止用户刚按 Enter 提交、PermissionDialog 立刻弹出时 Enter 被误读为"允许" | PermissionDialog 挂载后设 425ms 静默期，期间忽略 Enter/Space 按键 |
| **Optimistic busy flag + generation 计数** | Crush `agentBusyCache` | submit 时同步设 `agentBusy=true`（不等待 async state 更新），避免 Esc 在 stale idle state 到达前路由到错误处理。generation stamp 防止 stale probe 覆盖真实值。 | `useAgentStream` 的 `submit` 同步设 `isRunningRef=true` + 递增 `generationRef`，补充现有计数器设计 |
| **Index-addressed content blocks** | ivanleo `applyProviderEvent` | `ADD_CONTENT_BLOCK(index)` / `UPDATE_CONTENT_BLOCK(index)` 事件携带 block 索引，消费端按索引更新。匹配 Anthropic 线协议，天然支持并行 tool_use + 交错 text。 | 阶段②暂不改动 AgentEvent（已是消费后格式），但 `consumeStream` 内部可用索引累积 tool_call |
| **String-then-JSON.parse for tool_call.args** | ivanleo | `args` 类型为 `string | object`，先作为字符串累积 JSON delta，`final` 时 `JSON.parse`。解析失败保留字符串。匹配线协议实际行为，比尝试流式解析更健壮。 | `consumeStream` 的 tool_call 累积逻辑已用 Map<id, inputDelta> 字符串拼接 → 最后 parse，已兼容 |
| **Split-border card** | ivanleo `Message.tsx` | 两区域卡片：header `borderBottom={false}` + body `borderTop={false}`，~6 行 Ink 实现视觉上一体的双区域卡片。 | ToolPanel 的 done/error 结果预览用此模式 |

### 7.2 权衡决策补充

| 决策点 | CC/CCode 做法 | Crush 做法 | ivanleo 做法 | ECode 决定 |
|--------|-------------|-----------|-------------|-----------|
| 流式 Markdown | 两组件 swap（forgiving→strict） | Prefix-cache 单组件 | 不做（有 bug） | Prefix-cache（借鉴 Crush） |
| Ctrl+C | interrupt per-turn + Ctrl+D 退出 | Ctrl+C 退出 + Esc 中断 | 禁用 | **双击 Ctrl+C 退出**（借鉴 CCode，2000ms 窗口），Esc 中断 streaming |
| 滚动 | `<Static>` + 终端原生 scrollback | 自研 lazy `list.List` + Prewarm | 无虚拟化，`flexGrow={1}` filler | **`<Static>` 冻结**（借鉴 CCode，O(n)→O(1)）|
| 权限弹窗 | Yes/Yes-always/No | Allow/Allow for Session/Deny + diff | 无 | **Yes/Yes-always/No + diff 预览**（借鉴 CCode + Crush diff 模式）|
| 输入框 | ink-multiline-input（大量自研补丁） | vendored textarea + history | 自研 ink-text-input fork，无历史 | **L2 单行自研**（实施方案选定，避免 ink-multiline-input 不成熟） |

### 7.3 实施计划应纳入但 spec 不做的高阶模式（留 M4+）

| 模式 | 来源 | 说明 | 留后原因 |
|------|------|------|---------|
| Lazy `list.List` + Prewarm | Crush | 只渲染可见行 + resize-settle 时预热缓存 | ECode 用 `<Static>` 已足够；长对话性能问题出现时再引入 |
| Offscreen spinner freeze | CC / Crush | 离屏 spinner 暂停动画，避免无意义 repaint | 阶段② spinner 数量有限，影响不大 |
| Per-tool renderers（独立文件） | Crush | 每个 tool 一个渲染组件文件 | 阶段② meta 驱动 switch 足够，~10 个 tool 不需要独立文件 |
| Dialog overlay stack | Crush | 弹窗栈支持嵌套 | 阶段②只有 PermissionDialog 一层弹窗，不需要栈 |
| Per-tool `maxResultSizeChars` + disk overflow | CC | 工具结果溢出到磁盘，UI 只显示截断 | ECode 当前结果直接存在内存消息里，够用 |
| Optimistic busy flag 防 stale probe | Crush | submit 时同步设 busy，async 确认后更新 | ECode generation 计数器已覆盖此场景 |

---

## 8. 验收标准

- [ ] `ecode`（无参 + TTY）进入沉浸式 REPL；`ecode "任务"` 仍走 one-shot
- [ ] REPL 输入：单行 + 上下历史（↑/↓）+ Tab 补全斜杠命令
- [ ] LLM 输出：Markdown + 代码高亮；流式不抖
- [ ] 工具执行：spinner + 计时 + ✅/❌ + 命令/diff 预览
- [ ] dangerous 工具弹 PermissionDialog：Yes / Yes-always / No
- [ ] deny 后 LLM 收到 "用户拒绝执行工具" 并调整策略
- [ ] Windows 下 Ctrl+C 双击退出；Esc 中断 streaming
- [ ] 斜杠命令 8 个全部可执行（/help /clear /model /exit /cost /compact /resume /sessions）
- [ ] `<Static>` 冻结历史，长对话不卡
- [ ] 现有单测全绿；新增 UI 组件测试
