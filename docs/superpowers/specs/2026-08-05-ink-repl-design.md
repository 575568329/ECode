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
├─ WelcomeScreen（未开始时：双栏圆角面板，详见 §8.4）
├─ ChatView（started 后）
│   ├─ <Static items={completedMessages}>  ← 冻结已完成消息
│   └─ 动态区
│       ├─ streamingText（流式文本）
│       ├─ activeTools[]（运行中工具）
│       └─ error（错误信息）
├─ PermissionDialog（pendingPermission 时替换 InputBar）
├─ InputBar（默认底部）
└─ StatusBar（单行贴底，必做，详见 §8.4）
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
- **首次 submit 时同步清屏**（清掉 WelcomeScreen 残留）：必须在 `submit` 函数体内**同步**执行 `\x1b[2J\x1b[H`（用 `hasClearedRef` 控幂等），**不能放 `useEffect`**——Ink `<Static>` 在 render 时冻结帧，`useEffect` 在 render 后才执行，那时 WelcomeScreen 已被冻结进输出，再清屏清不掉（CCode `App.tsx:736-739` 验证过的坑）

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

**符号**：工具调用 `▸ ToolName(arg)`（tool 色）、结果引导符 `↳`（result 色）。详见 §8.2。

**三态渲染**（借鉴 CCode ToolStatusLine.tsx）：

| 状态 | 显示 |
|------|------|
| Running | `<Spinner>`（brand 色 braille）+ `▸ ToolName(arg)` + 计时（≥3s 后显示，muted 色） |
| Done | `▸ ToolName(arg)` + `↳ ✓ 摘要 (耗时)` |
| Error | `▸ ToolName(arg)` + `↳ ✗ 错误摘要` |

**结果折叠 = per-tool 差异化**（不一刀切）：

| 工具 | 折叠策略 |
|------|---------|
| `bash`（成功） | 前 3 行 + `... N more lines` |
| `bash`（错误） | 前 5-8 行（错误栈关键信息常在后面） |
| `edit_file` / `write_file` | **完整 diff 不折叠**（diff 是精华，红绿增删行） |
| `read_file` | **不显示内容**，只显 `Read N lines`（内容主体预览意义不大） |
| `grep` | 前 3 行匹配 + `... N more matches` |
| 其他 | 工具名 + 参数摘要 |

> ⚠️ **历史区（`<Static>`）不可原地展开**：`<Static>` 冻结后已渲染 item 不再参与 React diff（内部 index 只前进），原地 toggle 展开在架构上做不到（CCode 的 `ctrl+o expand` 也只是字符串提示、未实现）。故历史区只显示折叠态 + `... N more lines` 文案；展开走 `/history <id>` 切视图（留 M4）。

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

> **不做 prefix-cache 流式 markdown**：`React.memo` 已天然隔离已稳定段落（等价 prefix cache），手写"安全边界探测 + 稳定前缀缓存"是过度设计；`marked` 全量解析 KB 级文本是微秒级，无性能瓶颈。CCode 流式期也是纯 `<Text>`。详见 §7.1 该条的否决说明。

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
  const { render } = await import('./ui/index.js')
  const instance = render(
    React.createElement(App, { model: values.model, cwd: process.cwd() }),
    { exitOnCtrlC: false }, // 必须关掉 Ink 默认 Ctrl+C，否则绕过清理逻辑
  )
  // render 同步返回 Ink 实例；退出清理见下方
}
```

**退出清理**（CCode `bin/ccli.ts:412-459` 标准模板）：
- `process.on('SIGINT', exitGracefully)`——接管 Ctrl+C：业务清理 → `instance.unmount()` → resume 提示 → `process.exit(0)`
- `process.on('exit', ...)`——同步兜底（此回调内不能跑 async）
- Windows Ctrl+C 兜底：raw mode 下部分终端不稳定产生 SIGINT，用 `stdin.prependListener('data')` 拦原始字节（对齐 §5.3 InputBar 的跨平台按键处理）

> ⚠️ **不切 alternate screen buffer**：CCode 明确拒绝 `\x1b[?1049h`（其函数名 `enterAlternateScreen` 是历史遗留，实际实现是 `\x1b[2J\x1b[H` 清屏）。alt buffer 在 Windows Terminal / iTerm / cmd 普遍无 scrollback，`<Static>` 写入后用户上滚看不到历史——体验死局。ECode 改用 `\x1b[2J\x1b[H` 清屏，保留主 buffer scrollback；退出无需 `\x1b[?1049l` 还原。

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
| **Prefix-cache streaming markdown** | Crush `streaming_markdown.go` | 比 CC 的两组件 swap（forgiving→strict）更优雅。缓存已渲染的稳定前缀（找到最后一个安全 markdown 边界：无未闭合代码块/列表标记），每 tick 只重渲染尾部增量。避免 swap 闪烁，单一渲染器。 | ❌ **已否决**：`React.memo` 等价 prefix cache，手写边界探测过度设计；`marked` 全量解析 KB 级文本微秒级无瓶颈。改用"流式纯文本 + completed full render"（见 §5.6） |
| **Dialog grace period** | Crush `dialog.go`，425ms/1500ms | 弹窗弹出时吸收从之前焦点组件残留的按键事件，防止用户刚按 Enter 提交、PermissionDialog 立刻弹出时 Enter 被误读为"允许" | PermissionDialog 挂载后设 425ms 静默期，期间忽略 Enter/Space 按键 |
| **Optimistic busy flag + generation 计数** | Crush `agentBusyCache` | submit 时同步设 `agentBusy=true`（不等待 async state 更新），避免 Esc 在 stale idle state 到达前路由到错误处理。generation stamp 防止 stale probe 覆盖真实值。 | `useAgentStream` 的 `submit` 同步设 `isRunningRef=true` + 递增 `generationRef`，补充现有计数器设计 |
| **Index-addressed content blocks** | ivanleo `applyProviderEvent` | `ADD_CONTENT_BLOCK(index)` / `UPDATE_CONTENT_BLOCK(index)` 事件携带 block 索引，消费端按索引更新。匹配 Anthropic 线协议，天然支持并行 tool_use + 交错 text。 | 阶段②暂不改动 AgentEvent（已是消费后格式），但 `consumeStream` 内部可用索引累积 tool_call |
| **String-then-JSON.parse for tool_call.args** | ivanleo | `args` 类型为 `string | object`，先作为字符串累积 JSON delta，`final` 时 `JSON.parse`。解析失败保留字符串。匹配线协议实际行为，比尝试流式解析更健壮。 | `consumeStream` 的 tool_call 累积逻辑已用 Map<id, inputDelta> 字符串拼接 → 最后 parse，已兼容 |
| **Split-border card** | ivanleo `Message.tsx` | 两区域卡片：header `borderBottom={false}` + body `borderTop={false}`，~6 行 Ink 实现视觉上一体的双区域卡片。 | ToolPanel 的 done/error 结果预览用此模式 |

### 7.2 权衡决策补充

| 决策点 | CC/CCode 做法 | Crush 做法 | ivanleo 做法 | ECode 决定 |
|--------|-------------|-----------|-------------|-----------|
| 流式 Markdown | 两组件 swap（forgiving→strict） | Prefix-cache 单组件 | 不做（有 bug） | **流式纯文本 + completed full render**（否决 prefix-cache，见 §5.6） |
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

## 8. 视觉系统（实现基准）

> 📌 **实现时以 [`ui-preview.tsx`](../../../ui-preview.tsx)（项目根目录）为视觉基准对照**。
> 该文件用真实 Ink + 17 色 token 渲染了全部 10 个关键界面（欢迎/对话/工具三态/diff/折叠/权限/thinking/状态栏/警告/窄终端），跑 `npx tsx ui-preview.tsx` 可看实际效果。
> **编码时若本节文字与 `ui-preview.tsx` 有出入，以 `ui-preview.tsx` 为准**——它是"活的"视觉规格，本节是它的文字化锚点。`ui-preview.tsx` 在项目根、不在 `src/` include 内，不参与 `tsc` build，M3.5 阶段②完成后可删。

### 8.1 配色 token（17 个，Catppuccin Mocha 基底）

集中定义在 `src/ui/theme.ts`，组件只引用 token 名、**禁止硬编码 hex**。

| Token | Hex | 用途 |
|-------|-----|------|
| `brand` | `#4ECDC4` | logo + `◆ ECode` 标签（**语义独占**，不散用到 info/accent 等） |
| `user` | `#89B4FA` | `❯ 你` 用户消息 + 选中项高亮 |
| `tool` | `#F9E2AF` | `▸ ToolName` |
| `result` | `#6C7086` | `↳` 工具结果引导符 |
| `success` | `#A6E3A1` | `✓` 成功 |
| `error` | `#F38BA8` | `✗` 错误 |
| `warning` | `#FAB387` | `▲` 警告 |
| `info` | `#89B4FA` | 一般提示、`↑` input token |
| `permission` | `#FAB387` | 权限弹窗边框（独立 token，不复用 error） |
| `thinking` | `#94E2D5` | `◐` 推理块 + italic |
| `suggestion` | `#7F849C` | Tab 补全浮层文字 |
| `accent` | `#89B4FA` | `▶` prompt 三角、选中项 |
| `muted` | `#6C7086` | 次要文本、计时、时间戳 |
| `border` | `#45475A` | 面板边框 |
| `diffAdded` | `#A6E3A1` | diff `+` 行 |
| `diffRemoved` | `#F38BA8` | diff `-` 行 |
| `inverseText` | `#1E1E2E` | 品牌色背景反白 |

> **关键决策**：`user` 用蓝（`#89B4FA`）而非绿——避免和 `success` 绿撞色（早期方案同色 bug）。ECode 是四家参考实现里唯一的冷色品牌（青绿 `#4ECDC4`），区别于 CCode(红)/Claude Code(珊瑚橙 `#D97757`)/OpenCode(暖橙 `#fab283`)。

### 8.2 符号体系（全单宽 Unicode 几何，禁用 emoji）

emoji（⚡⚠️💥）跨终端字宽不一致（1 vs 2 列）、彩色/单色渲染不一，会让前缀竖线错位。统一用单宽 Unicode 几何符号：

| 角色 | 符号 | Unicode | Token |
|------|------|---------|-------|
| 用户消息 | `❯` | U+276F | user |
| 助手消息 | `◆` | U+25C6 | brand |
| 工具调用 | `▸` | U+25B8 | tool |
| 工具结果 | `↳` | U+21B3 | result |
| 成功 | `✓` | U+2713 | success |
| 错误 | `✗` | U+2717 | error |
| 警告 | `▲` | U+25B2 | warning |
| thinking | `◐` | U+25D0 | thinking |
| spinner | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | braille | brand |
| prompt 三角 | `▶` | U+25B6 | accent |

> **`↳` 而非 `⎿`**：`⎿` 是 Claude Code 的核心视觉签名，开源对标产品直接同款会让用户第一眼觉得是"CC 套壳"，且用户会期待 CC 式折叠展示。`↳` 建立 ECode 自有视觉语言，且和 `❯`/`▸` 同属"指向"几何系，风格一致。

### 8.3 Logo（5 行方块 E + ▶_）

```
███████
█
█████   ▶_
█
███████
```

- 左侧 5 行 `█` 字符构成 E 字形（上横 / 左竖 / 中横 / 左竖 / 下横），右侧 `▶_` 是终端 prompt（"Code" 的 `_`）。
- 纯 `█` 字符，跨终端渲染 100% 一致（区别于 CCode 方块机器人、Claude Code 太阳花）。
- 配色：E 用 `brand`，`▶` 用 `accent`，`_` 用 `muted`。

### 8.4 各场景视觉规格

**① 欢迎界面**（`completedMessages` 为空时显示，首次 submit 后被 ChatView 替代）：
- 双栏圆角面板（`<Box borderStyle="round" borderColor={border}>`），顶部 `brand` 色标题 `─── ECode vX.Y.Z ───`
- 左栏：Logo + `Welcome!` + 加载状态（`✓ Loaded CLAUDE.md (project, N lines)` / `✓ model @ provider (connected)` / `cwd path (git)`）
- 右栏：Commands（`/help` `/model` `/clear`）+ Shortcuts（`esc` `ctrl+c×2` `↑↓`）
- **不放历史会话列表**（噪声——会话恢复走 `/resume` `/sessions` 命令）

**② 对话布局**：前缀+颜色区分（非边框卡片）。用户 `❯ 你`、助手 `◆ ECode`、工具 `▸ ToolName(arg)` + `↳ ✓结果`。无时间戳、无分隔线，靠 `marginBottom` 分隔。

**③ 工具三态**：Running = `⠋ spinner`(brand) + `▸ ToolName(arg)` + 计时(≥3s 显 muted)；Done = `↳ ✓ 摘要 (耗时)`；Error = `↳ ✗ 摘要`。

**④ diff**：edit/write 完整显示不折叠，行号 + `-`/`+` 前缀，删行 `diffRemoved`、增行 `diffAdded`。

**⑤ 工具结果折叠**：per-tool 差异化（见 §5.5）。历史区不可原地展开（`<Static>` 限制）。

**⑥ 权限弹窗**：`permission` 色圆角边框，三选项（Yes / Yes-don't-ask-again / No），`❯`(accent) 指示选中项，挂载后 425ms 静默期（grace period，防残留 Enter 误触发）。

**⑦ thinking 推理块**：手撸左边框（一列 `│`(thinking) + paddingLeft）+ `thinking` 色 italic；spinner 用 `◐`(thinking) 区别于工具的 braille。

**⑧ 状态栏**（单行贴底，**必做**）：`⏱ 耗时 | ↑↓ tok | $费用 | Ctx% | model @ provider | [动态段]`。
- Ctx% 颜色阈值：≤80% `muted` / >80% `warning` / >95% `error`
- 动态段按状态切换：idle→`/help for commands`、streaming→`esc to interrupt`、双击 Ctrl+C 窗口期→`press ctrl+c again to exit`、pending permission→不显示（弹窗自带）
- 费用 session 内累计；token 段 `↑input ↓output`（方向箭头明确语义）；模型段 `model @ provider`（多 provider 无歧义）

**⑨ 警告/错误**：`▲ message`(warning) / `✗ message`(error)。

**⑩ 窄终端降级**（宽 <60 列）：欢迎界面右栏（Commands/Shortcuts）隐藏，状态栏省略 token 段和快捷键段。

---

## 9. 验收标准

**功能验收**：
- [ ] `ecode`（无参 + TTY）进入沉浸式 REPL；`ecode "任务"` 仍走 one-shot
- [ ] REPL 输入：单行 + 上下历史（↑/↓）+ Tab 补全斜杠命令
- [ ] LLM 输出：Markdown + 代码高亮；流式纯文本不抖、completed 后 full render
- [ ] 工具执行：spinner + 计时 + `✓`/`✗` + 命令/diff 预览（per-tool 折叠策略）
- [ ] dangerous 工具弹 PermissionDialog：Yes / Yes-always / No
- [ ] deny 后 LLM 收到 "用户拒绝执行工具" 并调整策略
- [ ] Windows 下 Ctrl+C 双击退出；Esc 中断 streaming
- [ ] 斜杠命令 8 个全部可执行（/help /clear /model /exit /cost /compact /resume /sessions）
- [ ] `<Static>` 冻结历史，长对话不卡
- [ ] 现有单测全绿；新增 UI 组件测试

**视觉验收**（对照 `ui-preview.tsx`，以它为准）：
- [ ] 配色 17 个 token 集中在 `src/ui/theme.ts`，组件零硬编码 hex
- [ ] 符号全单宽 Unicode 几何（`❯ ◆ ▸ ↳ ✓ ✗ ▲ ◐`），无 emoji
- [ ] Logo = 5 行方块 E + `▶_`，brand 色
- [ ] 欢迎界面：双栏圆角 + 加载状态（CLAUDE.md / provider 连通 / cwd），无历史会话列表
- [ ] 对话：前缀+颜色区分（用户蓝 / 助手青绿 / 工具金黄 / 结果灰）
- [ ] 状态栏：单行含耗时/tok/费用/Ctx%/model，Ctx% 三色阈值，动态段按状态切换
- [ ] **不切 alternate screen buffer**：首次 submit 同步 `\x1b[2J\x1b[H` 清屏，主 buffer scrollback 可上滚历史
- [ ] 退出清理：`exitOnCtrlC:false` + SIGINT 接管 + `process.on('exit')` 兜底
