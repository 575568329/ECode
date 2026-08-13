---
layer: tui
status: draft
depends_on:
  - 详设/2026-08-12_M2-TUI实施方案_待审核.md
  - 详设/2026-08-11_ECode-MVP详设_待审核.md（§5 TUI / §10 M2）
  - 规范/2026-08-11_MVP-TUI设计规范_待审核.md
  - 解析/2026-08-13_MVP-终端Markdown渲染调研_待审核.md
---

# ECode TUI 渲染架构重构：Static + Overlay Pager

> 日期：2026-08-13 · 状态：**草案待审阅**
> 背景：M2 去 `<Static>`（commit 638480f）后暴露两个阻断性问题——① 满屏后 Windows clearTerminal 致无法滚动；② text/tool 顺序错乱。
> 本文是渲染架构重构的详细设计，基于 **codex / opencode / aider 三项目实证调研**（见附录 B）。
> 标 ★ 的决策点需要讨论拍板。

---

## 1. 问题陈述

### 1.1 现状与症状

M2 最终交付时，为换「/clear 干净 + Ctrl+O 全展开 + resize 稳定」而去掉了 Ink `<Static>`（commit 638480f），改为**消息全动态区**（`Conversation.tsx` 里 `items.map` 全部在动态 Box column）。真机使用暴露两个阻断症状：

1. **满屏后无法滚动**：对话稍长或展开工具后，在输入框打字时整个界面被「钉在顶部、滚不动」。
2. **text/tool 顺序错乱**：LLM 先输出文本→调工具→再输出文本（跨 iter）时，所有文本被拼成一整段固定显示在工具**上面**，而非按输出顺序交替。

### 1.2 根因（代码级）

**症状 1 根因**——Ink 7 在 Windows 上对满屏帧强制全清屏（`node_modules/ink/build/ink.js:89-112`）：

```js
const isWindowsConsole = process.platform === 'win32';
const shouldClearTerminalForFrame = ({ viewportRows, previousOutputHeight, nextOutputHeight, ... }) => {
  const wasFullscreen = previousOutputHeight >= viewportRows;
  const isFullscreen = nextOutputHeight >= viewportRows;
  // Windows 特例：满屏帧每帧 clearTerminal（修 #969 的 scroll desync）
  if (isWindowsConsole && (wasFullscreen || isFullscreen)) return true;
  return wasOverflowing || (isOverflowing && hadPreviousFrame) || ...;
};
// → renderInteractiveFrame 执行 ansiEscapes.clearTerminal
//   = \x1b[2J（擦屏）+ \x1b[3J（擦 scrollback）+ \x1b[H（光标归位 0,0）
```

**致「滚不动」的真正元凶是 `\x1b[3J`（每帧擦 scrollback）**——历史被清，滚轮无历史可滚；全清可见区后重写当前帧，视口被钉在新帧。去 `<Static>` 后，动态区 `outputHeight` 随对话增长必然 ≥ `viewportRows` → `isFullscreen=true` → 每帧 `clearTerminal` → 滚不动。

**症状 2 根因**——`TuiApp.tsx:126` 的 `assistantText` 跨整个 `runLoop` 所有 iter 累积（不重置），加上 `Conversation.tsx` 把 `streamingText`（全部文本）固定渲染在 `toolEntries`（全部工具）之前：

```tsx
// Conversation.tsx —— 文本区和工具区分离，不按交替顺序
{streamingText && <GrayStreaming />}   // 全部文本（iter1+iter2 拼一起）
{toolEntries.map(...)}                  // 全部工具
```

真实时序 `text1 → tool → text2` 被压扁成 `[text1+text2] → [tool]`。

### 1.3 需求约束（四个，须同时满足）

| # | 需求 | 来源 |
|---|---|---|
| ① | **展开/收起** 工具调用（含历史） | 用户交互核心 |
| ② | **看子进程内容**（bash 长输出 / 实时流） | M3+ bash 安全 + 后续 MCP/skill |
| ③ | **不满屏溢出**（否则触发 Windows clearTerminal → 滚不动） | 平台铁律 |
| ④ | **可滚动**（用户滚轮看历史） | 基础体验 |

---

## 2. 调研结论：三项目实证

> 完整调研报告见附录 B。本节是结论。

### 2.1 铁律（三项目都用血泪验证）

> **「原生 scrollback 滚动」与「就地可交互历史」在同一块屏幕区域里是互斥的。**
> 字节一旦交给终端 scrollback（物理写出），就再也改不动——无法就地展开/收起/追加子进程流。

**没有任何项目试图在同一块区域同时要这两个。** 它们的解法都是「主视图选一边，可交互挪到别处」。

### 2.2 三项目解法对比

| 项目 | 主视图（日常交互） | 可交互/查全量放哪 |
|---|---|---|
| **codex**（Rust/Ratatui） | inline：历史用 ANSI（scroll region + 反向换行）物理写进终端 scrollback，滚轮友好，**历史死** | **独立 overlay pager**（Ctrl+T）：全屏，内存 transcript 为真相，虚拟滚动 + 展开 + 懒加载 |
| **opencode**（TS/OpenTUI 自建） | 两种模式二选一：全 REPL（alt screen，历史全交互，**失原生滚轮**）/ run 模式（split-footer：4 行活区 + scrollback，历史死） | 全 REPL 里靠自建键盘+鼠标滚动 |
| **aider**（Python/rich） | 纯 inline：MarkdownStream（6 行 Live 活窗 + 稳定行 flush 死），滚轮友好，**完全放弃历史交互** | 无（死文本） |

### 2.3 关键启示

1. **codex 的 inline 模式 = Ink `<Static>` 哲学的极致版**。`<Static>` 本质就是「渲染一次后把行固化到终端 scrollback，永不再重绘」——和 codex 的 `insert_history_lines` 干的事一模一样。
2. **「可交互查看历史」的正确位置是独立 overlay/modal，不是主消息流**。codex 把它放在 Ctrl+T pager 里。
3. **aider 的 MarkdownStream**（活窗 + flush 死行）证明：即便没有自建渲染层，split-footer 思路也成立——代价是历史不可交互。
4. **opencode 自建了 OpenTUI**（MIT/TS/Solid/React 绑定），且把 `split-footer` 作为一等公民。但这是**长期**选项，MVP 不必。

---

## 3. 方案选型

### 3.1 三条路

| 路 | 原生滚轮 | 历史展开/收起 | 子进程流 | 成本 | 谁走过 |
|---|---|---|---|---|---|
| **A. Static + Overlay Pager** | ✅ 主视图 | ✅ 在 overlay 里 | ✅ 活区截断 + scrollback 全量 | **中**（借 Ink，加 overlay） | codex |
| B. alt screen + 自建视口 | ❌ 失效，改键盘+鼠标 | ✅ 全交互 | ✅ | **高**（引入 OpenTUI 或自建） | opencode |
| C. 纯 Static，放弃历史交互 | ✅ | ❌ | scrollback 全量 | **低** | aider |

### 3.2 选 A 的理由（★ 待拍板）

1. **四个需求都满足**，且 codex 已验证。
2. **不需要自建渲染层**——主视图复用 Ink `<Static>` + 活区；overlay 用第二个 Ink instance（alt screen）。成本远低于 B。
3. **贴合 ECode 定位**（终端 Agent CLI，不是 opencode 那种全交互 REPL）：主交互靠输入+流式，偶尔进 overlay 看历史详情。
4. **保住原生滚轮**——用户先前明确否过 alt screen（杀 scrollback）。A 维持非 alt screen。

### 3.3 反驳（什么情况下会反悔）

- **反悔点**：若实践中发现 overlay pager 使用频率极高（用户频繁进 overlay 才能看历史），说明「主视图历史死」的代价太大 → 此时升级到 B（引入 OpenTUI 替换 Ink）。
- **证伪条件**：M3+ 工具/skill/MCP 上来后，若用户每周进 overlay 超 N 次（N 待定，建议 ≥10），或主视图折叠摘要信息量不足导致反复进出 → 重评估。
- **不可反悔的底线**：满屏 clearTerminal 必须根治（症状 1），否则产品不可用。A 从根因消除（见 §4.2）。

---

## 4. 详细设计

### 4.1 架构总览（三区模型）

```
┌─ 终端原生 scrollback（Ink 不管，滚轮自由滚）─────────┐
│  Static 区（<Static items={committed}>）：           │
│    user msg / assistant-text / tool(含结果) / tool-group │
│    渐进 append，每片段完成即固化（永不重绘）          │
└──────────────────────────────────────────────────────┘
┄┄ 光标当前位置（老内容上滚进 scrollback）┄┄┄┄┄┄┄┄┄┄┄┄
┌─ 活区（动态区，每帧 Ink 重绘，outputHeight 只算这块）─┐
│  GrayStreaming（流式中文本，≤5 行折叠）              │
│  ToolRunning（当前执行中工具，1 个，spinner + 摘要）  │
│  ActivityBar（状态指示，1 行）                       │
│  InputStream（输入框 + 斜杠补全）                    │
│  底行（StatusBar · ShortcutHint）                    │
└──────────────────────────────────────────────────────┘

         【按 Ctrl+T / /peek → 进 Overlay Pager】

┌─ Overlay Pager（临时全屏 alt screen，独立 Ink instance）─┐
│  内存 transcript（messages）为单一真相，按序渲染：       │
│    user / assistant-text / tool（全部，含历史）          │
│  工具可展开/收起（overlay 内交互，内容在内存可变）       │
│  虚拟滚动：scrollOffset + 视口截断（只渲染可见行）       │
│  键盘：PgUp/PgDn/↑↓ 滚、Enter 展开、q/Esc 退出          │
└─────────────────────────────────────────────────────────┘
```

**三区职责**：

| 区 | 内容 | 可变？ | 滚动 |
|---|---|---|---|
| Static（scrollback） | 已完成的历史片段 | 否（固化） | 终端原生滚轮 |
| 活区（动态区） | 当前流式段 + 执行中工具 + 输入 | 是（每帧重绘） | 不滚（恒小） |
| Overlay | 全量 transcript（任意历史） | 是（交互） | 自建虚拟滚动 |

### 4.2 满屏消除：代码级证明

**为什么 Static 能根治满屏 clearTerminal？**

Ink 的 render 把输出分成两路（`ink.js:348`）：

```js
const { output, outputHeight, staticOutput } = render(this.rootNode, ...)
//                ↑ 动态区             ↑ Static（单独 write 到 scrollback）
```

- `staticOutput` 走单独路径，`write(staticOutput)` 直接打到 stdout（进 scrollback），**不计入 `output` / `outputHeight`**。
- `outputHeight`（用于 `isFullscreen` 判断）**只算动态区**（`ink.js:754`）。
- 因此 Static 内容再多，也不让 `outputHeight` 增长。

**A 方案下动态区内容（行数硬上限）**：

| 动态区组成 | 行数上限 |
|---|---|
| GrayStreaming（`foldStreamText` 限 5 行 + 折叠提示 1 行；小终端压到 3 行） | ≤6 |
| 执行中工具（**有界列表**：最多展示 3 个 running，超出合并 `● N 个工具运行中`） | ≤4 |
| ActivityBar + 输入框 + SlashSuggest（斜杠时，最多 6 条）+ 底行 | ≤10 |
| **合计硬上限** | **≤20**（须 < `viewportRows`，由单测断言保证，见 §6） |

> ⚠️ **「与工具数量无关」的证明必须靠硬上限，不能靠「工具串行」**。审阅 P1-1 指出：`loop.ts:275-277` 的 `executeTools` 中 **readonly 工具 `Promise.all` 并行**（read_file/glob/grep 都并行），`tool_use_start` 连续多次触发、`onToolResult` 乱序回流——「同一时刻只 1 个工具」是**假命题**（本文档初稿曾犯此错，与用户上轮预警的「工具多了会超出」同一类拍脑袋）。**正确保证方式**：① 执行中工具有界列表（超 3 合并）；② 动态区行数硬常量 + 单测断言 `outputHeight ≤ viewportRows - 安全余量`（§6）。

> ⚠️ **触顶失败模式（必须杜绝）**：Windows 分支是 `wasFullscreen || isFullscreen`（**曾触顶也持续触发**），一旦触发每帧重写 `clearTerminal + fullStaticOutput（累积全量历史）+ outputToRender`（`ink.js:768`），长对话下 O(历史行数)/帧，剧闪卡顿，比 M2 全动态更惨（M2 的 `fullStaticOutput` 为空）。**故「永不触顶」是硬约束，不是优化项**。

`isFullscreen = false`（由硬上限保证）→ 走增量更新（`log-update` 的 `eraseLines(动态区行数) + 重写`）→ 只擦底部固定行数 → **不打断滚轮位置**（增量更新不碰 scrollback）。

### 4.3 数据模型

#### 4.3.1 内存单一真相：messages（已有，复用）

`messages: Message[]`（loop 维护，`core/types.ts`）是 overlay pager 的数据源。它按 role 分（user/assistant），一个 assistant message 的 `content` 是有序 block 数组（text / tool_use 交替）。**不新增数据结构**，overlay 渲染时遍历 messages 的 content blocks（类似现有 `messagesToItems`，但带交互态）。

#### 4.3.2 主视图 Static items（渐进 append 的渲染单元）

```ts
/** 推入 <Static> 的已完成片段。每片段完成即 append，永不重绘。 */
type CommittedItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant-text'; id: string; text: string }
  | { kind: 'tool-group'; id: string; calls: CommittedToolCall[] }

interface CommittedToolCall {
  use: ToolUseBlock
  result: ToolResultBlock
  /** 进 Static 时的展示形态（固化后不可变） */
  display: 'collapsed' | 'expanded'
}
```

**连续工具合并**：`tool-group` 把无 text 间隔的连续工具调用合成一个折叠块（`● N 个工具: bash, ls [摘要]`），压缩 Static 视觉占用。遇下一段 assistant-text 即截断当前 group。

#### 4.3.3 活区：活跃段（流式单段 + 工具有界列表）

```ts
/** 动态区活跃内容。streaming 与 running 可并存（流式中也可能并行触发工具）。 */
interface ActiveState {
  /** 流式中文本（GrayStreaming）；null = 无流式 */
  streaming: { text: string } | null
  /** 执行中工具（有界列表）。UI 只渲染前 MAX_RUNNING_VISIBLE 个，超出合并 */
  running: RunningTool[]
  /** idle = streaming 为 null 且 running 为空 */
}

interface RunningTool {
  /** onToolStart 只给 name（P1-2：此时 tool_use input 尚未解析，拿不到 use） */
  name: string
  /** 该 name 对应的 onToolResult 到来时移除（已 flush 进 Static） */
}

const MAX_RUNNING_VISIBLE = 3   // 超 3 个合并成「● N 个工具运行中」
```

**为什么是有界列表而非单槽**：readonly 工具并行（P1-1），一次 iter 可能有多个 `tool_use_start` 在任何 `onToolResult` 之前触发。单槽会丢前面的。有界列表（上限 3 + 合并）保证：① 不丢工具；② 行数恒有界（≤4 行）。外加常驻的 ActivityBar / 输入框 / 底行。

#### 4.3.4 Overlay 状态

```ts
interface OverlayState {
  open: boolean
  scrollOffset: number          // 视口顶部在 transcript 中的行偏移
  expandedIds: Set<string>      // 展开的 tool-call id
  cursorId?: string             // 光标所在项（键盘导航用）
}
```

### 4.4 主视图渲染流程（commit 调度 + 顺序）

**核心规则：按 LLM 输出顺序，每片段完成即从活区「毕业」进 Static。**

驱动来自 loop callbacks（`loop.ts` 的 `onText` / `onToolStart` / `onToolResult`）：

```
事件                  活区动作                              Static 动作
───────────────────────────────────────────────────────────────────────
onText(t)            active.streaming append t              —
                     （streaming 为 null 时新建）

onToolStart(name)    flush 当前 streaming-text → Static      —
                     active.running.push({ name })
                     （P1-2：此时只有 name，tool_use input 尚未解析；
                      assistant message 也在 finally 之后才进 messages，
                      故执行中拿不到 use，无 input 摘要）

onToolResult(id,_,r) active.running 移除该 id 对应项         append tool(use, result)（合并进 group）
                     （use 从 messagesRef 反查 id 配对——此时     注：此刻 assistant message 已在 messages
                      assistant message 已 push，可查到 use）   （finally 先于 executeTools），反查可行

runLoop 结束         flush 剩余 streaming-text → Static      append 最后 text 段
（stop/abort/error） active 清空（streaming=null, running=[]）
```

**关键修正（P1-2）**：
- `onToolStart` 时 `tool_use` 的 input 还在 `tool_use_delta` 累积、未解析；assistant message 到 `finally`（`loop.ts:184`）才进 messages——**都在 `onToolStart` 之后**。故执行中工具**只能 spinner + name，无 input 摘要**。
- `onToolResult` 触发时 `finally` 已执行（在 `executeTools` 之前），assistant message 已在 messages → **从 `messagesRef` 按 `id` 反查 `use` 可行**（现有 `TuiApp.tsx:143-148` 已是此模式）。

**时序图**（跨 iter 的 text1 → tool → text2；tool use 在 onToolResult 时才拿到）：

```
iter1:  onText(t1)  onText(t1) onToolStart onToolResult(bash)
         │            │           │              │
活区:   [stream:t1] [stream:t1] [running:bash]  [running空]
Static:   —           —        [text1]         [text1, tool(bash)]

iter2:  onText(t2)  onText(t2)  ...stop
         │            │           │
活区:   [stream:t2] [stream:t2]  [清空]
Static: [text1,tool] [text1,tool] [text1,tool,text2]
```

**结果**：Static 按序含 `[text1, tool, text2]`，与 LLM 输出顺序一致。✓ 修复症状 2。

**commit 到 Static 的充要条件**（借鉴 M2 方案 B.4）：
- assistant-text 段：遇 `onToolStart` 或 iter 结束（流式停止）即落定。
- tool：**必须等 `onToolResult`（拿到结果 / is_error / 中断固化终态）**才进 Static；`use` 在此刻从 `messagesRef` 反查。执行中（spinner）的 tool **绝不进 Static**，否则状态永远卡在 ⟳。
- 中断场景（try/finally）：确保固化的中间态是终态（如「已中断，保留 N 行」）才推。

### 4.5 Overlay Pager

#### 4.5.1 触发与生命周期

- **进入**：`Ctrl+T`（学 codex）或 `/peek` / `/history` 命令。
- **实现路径（★ 实施前必做 spike 验证，二选一）**：
  - **候选 A（unmount + 第二 Ink instance，倾向）**：主 Ink instance `unmount()`（从 `instances` WeakMap 删，`ink.js:565`）→ 开第二个 Ink render（`alternateScreen: true`）渲染 pager → 退出时销毁 overlay instance + 主 instance 重新 `render()`。**难点：unmount 后 React 状态全丢（`messages` 在 TuiApp state），remount 要从 `messagesRef` 重灌**——`messagesRef` 是 ref 不丢，重灌可行，但要显式做状态保活。
  - **候选 B（suspendTerminal + 原始 ANSI 自绘）**：主 instance `suspendTerminal()`（`ink.js:683`，让出 TTY）+ overlay 自己用 ANSI 画。**注意：`suspendTerminal` 设计意图是给子进程让 TTY（`beginSuspend` 关 raw mode，`ink.js:898`），不是给第二 Ink**；且自绘 overlay（键盘解析 + 布局 + 虚拟滚动）**≈ 半个 OpenTUI 渲染层工作量**，成本远高于候选 A，仅作 fallback。
  - **倾向候选 A**（保活 messagesRef 即可，成本最低）。实施前用 throwaway 脚本验证 unmount/remount 同 stdout 可行。
- **退出**：`q` / `Esc` / `Ctrl+T` → 销毁 overlay instance + 退出 alt screen → 主 instance 恢复。
- **数据源**：overlay 读 `messagesRef.current`（内存单一真相，ref 不随 unmount 丢），进入时冻结快照（MVP）或实时跟随（后续）。

#### 4.5.2 渲染（虚拟滚动 + 可交互）

```
Overlay 内容 = renderTranscript(messages, expandedIds)
             = 按序展开每个 content block：
               user-text / assistant-text(Markdown) / tool-use(可展开)
```

- **视口截断**：`scrollOffset` + 终端高度 → 只渲染 `[offset, offset+viewportRows)` 行。上方/下方超出部分不渲染（虚拟化，支持上千条历史）。
- **行高预算**：渲染前对每项 `desiredHeight(width)` 预算行数（借鉴 codex `Renderable` trait），累加定位光标项。
- **展开/收起**：`Enter` toggle 光标项的 `expandedIds`。展开后该项高度变大，视口重算。
- **键盘**：`PgUp/PgDn` 翻页、`↑↓` 逐行 / 跳项、`g/G` 顶/底、`/` 搜索（后续）。

#### 4.5.3 工具展示

- 折叠态：单行摘要（`summarize`，复用 `toolview.ts`）。
- 展开态：完整 `input` + 完整 `result.content`（从 `messages` 取，**不截断**——overlay 就是看全量的地方）。
- 子进程长输出：展开后全量显示 + overlay 内滚动。

### 4.6 子进程输出处理（bash 等）

借鉴 codex `live_output.rs` + opencode `Shell`：

| 阶段 | 活区展示 | Static 展示 | Overlay 展示 |
|---|---|---|---|
| 执行中 | spinner + name（P1-2：结果未到，无输出可截） | — | — |
| 完成 | （已 flush） | 摘要（折叠，进 group） | 全量（展开看） |

**截断常量**（`toolview.ts` 统一）：
- 活区执行中：`head=3, tail=3`，单行 `maxChars=200`，超长 `... N bytes omitted ...`。
- Static 工具摘要：`TOOL_CALL_MAX_LINES=5`（用户 shell 命令放宽到 50）。
- Overlay：**不截断**（除非单条 > 1 MiB，head+tail 兜底，防止内存爆）。

**实时流式子进程**（长跑命令，如 `npm test`）：MVP 先做「完成后摘要 + overlay 看全量」。实时 tail（活区滚动尾部）留后续（复杂度高，需 pipe 子进程 stdout 增量进活区）。

### 4.7 展开/折叠策略

| 位置 | 可交互？ | 默认形态 |
|---|---|---|
| Static（scrollback 历史） | **否**（固化） | 折叠摘要（连续工具合并成 group） |
| 活区（当前执行中工具） | 有限（spinner + 摘要，MVP 不展开） | 摘要 |
| Overlay | **是**（任意历史工具展开/收起） | 折叠，按需展开 |

> 旧设计（Ctrl+O 全展开主视图历史）**废弃**——历史进 Static 后不可变，Ctrl+O 改为 overlay 内的全展开快捷键，或移除（overlay 里逐项展开更清晰）。

### 4.8 /clear 行为

Static 内容物理写在 scrollback，**无法用 ANSI 擦除已滚出的部分**（Static 固有特性，所有 CLI 通病）。`/clear` 策略：

1. **可见区清干净**：`/clear` 时主 Ink instance 发 `clearTerminal`（`\x1b[2J\x1b[3J\x1b[H`）或调 `ink.clear()` → 当前屏清空，光标归顶。
2. **重置 Static items**：清空 `committed[]` + remount（`clearKey++` 重置 `<Static>` 内部 index，避免后续消息不渲染——M2 commit 7ef1bc3 已踩过）。
3. **重置 messages / overlay state**。
4. **scrollback 物理残留接受**：与 bash `clear` 一致（清屏但 history 命令还在）。
5. **resize reflow 兜底（P2-4）**：若要 /clear 后重放历史（宽度重排），需保留 messages 快照。**当前 `/clear` 清空 `messagesRef`（`TuiApp.tsx:253`）会丢失重放能力**——MVP 接受「/clear 后老历史宽度不重排」（滚轮可见即可）；若要 reflow，改为「/clear 保留 `messagesRef` 快照供重放，只清 `committed[]`」（后续优化）。

### 4.9 resize 行为

- **宽度变小**：Ink `resized()`（`ink.js:279`）自动 `log.clear()` + 重绘动态区。Static 已在 scrollback，不受影响（但 Static 行不 reflow——见风险 §8）。
- **高度变化**：活区恒小，不受影响。Overlay 视口重算 `viewportRows`。
- **M2 的 resize 异常**（去 Static 时报告的）：源于动态区全量重渲染抖动。A 方案动态区很小，resize 影响反而更小。需真机复测确认。

---

## 5. 接口（对 loop 的影响）

**loop callbacks 基本不动**——`onText` / `onToolResult` / `onIter` / `onActivity` 足够驱动 commit 调度。**`onToolStart(name)` 触发时 `tool_use` input 尚未解析、assistant message 亦未进 messages（P1-2），执行中工具只能显示 name + spinner**。

**可选增强**（非 MVP 必需）：若要在执行中就显示 input 摘要（如命令预览），需在 `tool_use_end`（`loop.ts:140`）加 `onToolReady?(use: ToolUseBlock)` callback。MVP 接受「执行中只显 name」，`onToolResult` 时从 `messagesRef` 反查 use（现有 `TuiApp.tsx:143-148` 已是此模式）。

---

## 6. 错误处理与边界兜底

| 场景 | 处理 |
|---|---|
| 活区逼近满屏（小终端 24 行 + 斜杠补全 + 并行工具） | **硬上限（非软上限）**：GrayStreaming 小终端压 3 行；SlashSuggest 最多 6 条；执行中工具超 3 合并；**单测断言 `动态 outputHeight ≤ viewportRows - 4`**（安全余量） |
| 触顶雪崩（动态区曾 ≥ viewportRows） | Windows `wasFullscreen\|\|isFullscreen` 持续触发，每帧重写 fullStaticOutput（O(历史)/帧，剧闪）。**靠上面硬上限杜绝**，不接受偶发触顶 |
| 工具结果超大（> 1 MiB） | Static 摘要截断；overlay 内 head+tail 兜底；内存 messages 保留全量（或落 LogStore，overlay 懒加载） |
| 中断（Ctrl+C） | loop try/finally 已固化；活区 flush 终态（「已中断，保留 N 行」）进 Static |
| Overlay 打开时新消息到达 | overlay 读 `messagesRef` 快照（进入时冻结），退出后主视图已 commit；MVP 冻结即可 |
| Ink 多 instance 冲突 | §4.5.1 候选 A（unmount/remount）为主；**实施前 spike 验证状态保活**；候选 B（自绘）成本≈半个 OpenTUI，仅作 fallback |

---

## 7. 实施计划（分阶段 + 验收）

### 阶段 1：主视图重构（Static + 顺序）—— 修复症状 1+2

**改动**：
- `TuiApp.tsx`：`streamingText + toolEntries` 两状态 → `committed: CommittedItem[]` + `active: ActiveSegment`；实现 §4.4 的 flush 调度。
- `Conversation.tsx`：恢复 `<Static items={committed}>`；动态区只渲染 `active` + 常驻 UI。
- 工具进 Static 默认折叠 + 连续合并（`tool-group`）。
- `/clear` 发 `clearTerminal` + remount。

**验收**：
- 长对话（50+ 轮）+ 展开后，输入框打字**不被钉顶**，滚轮自由滚（症状 1 修复）。
- text1 → tool → text2 跨 iter，Static 按**顺序**显示（症状 2 修复）。
- 工具连续调用合并成一个折叠块。
- `/clear` 可见区干净。

### 阶段 2：Overlay Pager —— 满足需求 ①②

**改动**：
- 新增 `tui/OverlayPager.tsx`（alt screen Ink instance + 虚拟滚动 + 展开）。
- `Ctrl+T` / `/peek` 触发；`q/Esc` 退出。
- transcript 渲染：遍历 messages content blocks，工具可展开看全量。

**验收**：
- overlay 里任意历史工具可展开看完整 input + result。
- 虚拟滚动支持 1000+ 条历史不卡。
- 子进程长输出（bash 跑测试）在 overlay 展开看全量。

### 阶段 3（可选优化）

- 实时子进程流式（活区 tail）。
- overlay 搜索 `/`、跳转。
- `Ctrl+O` 在 overlay 内全展开。

**测试调整**：现有约 272 测试中，`Conversation.test.tsx`(10) / `App.test.tsx`(6) / `messages.test.tsx`(6) 是重写区（去 Static 后断言变）；若按 §5 加 `onToolReady` callback，`loop.test.ts`(9) 也要动。`toolview.ts` 纯逻辑层（summarize/groupByName）复用。**新增测试**（对应 P1）：① MockProvider 喂「2 个 readonly 工具并行」断言活区有界列表不丢工具；② 动态区行数硬上限断言（防 P1-3 触顶）；③ commit 时序（onToolResult 后 use 反查、text/tool 顺序正确）。

---

## 8. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| **动态区触顶 → fullStaticOutput 每帧重绘雪崩** | **致命**（剧闪/卡顿，比 M2 更惨） | §6 硬上限 + 单测断言 `outputHeight ≤ viewportRows-4` 杜绝；组件行数全硬常量 |
| **readonly 工具并行**（read_file/glob/grep `Promise.all`） | 活区可能多个 running；`tool_use_start` 连续触发 | 执行中工具有界列表（≤3 展示 + 合并「N 个运行中」），行数恒有界（P1-1） |
| **Overlay unmount/remount 状态保活** | overlay 退出后主视图状态丢 | `messagesRef` 是 ref 不随 unmount 丢；remount 重灌；实施前 spike（P1-4） |
| **Static 行 resize 不 reflow** | 缩窄终端时，Static 历史行不重排（宽度不对） | codex 用「内存为真相 + purge scrollback 重放」（`transcript_reflow.rs`）；MVP 接受不 reflow，或 /clear 后重放（需保留 messages 快照，见 §4.8） |
| **历史不可就地展开**（主视图） | 用户必须进 overlay 看详情 | 折叠摘要信息量做足（工具名 + inputDigest + 状态 + 行数）；overlay 入口显眼（Ctrl+T 提示在底栏） |
| **scrollback /clear 残留** | 滚轮往上还能看到旧会话 | 接受（CLI 通病）；或 `/clear` 发 `\x1b[3J`（清 scrollback，部分终端支持） |
| **overlay 频繁进出** | 体验割裂 | 监控使用频率（§3.3 证伪条件），超阈值升级 B |

**取舍小结**：
- ✅ 保住：原生滚轮、满屏根治、text/tool 顺序、子进程全量可查（overlay）。
- ❌ 放弃：主视图历史就地展开/收起（挪到 overlay）。
- ⚠️ 接受：Static resize 不 reflow、/clear scrollback 物理残留。

---

## 9. 长期演进（OpenTUI 迁移路径）

若 §3.3 的证伪条件触发（overlay 频繁进出 / 主视图历史死代价太大），升级到方案 B：

1. **引入 OpenTUI**（`@opentui/core` + `@opentui/react`，MIT/TS/Solid/React 绑定，生产验证）替换 Ink。
2. 切到 alt screen 全 REPL 模式：历史全量挂载、任意可交互展开/收起、自建键盘+鼠标虚拟滚动。
3. overlay pager 降级为「跳转命令」（`/peek <id>` 把指定消息拉回视口），因为主视图已全交互。

**不在 MVP 做**——A 方案能以 1/10 成本覆盖 80% 体验（opencode run 模式 + codex inline 已验证）。

---

## 10. 开放问题

| # | 问题 | 倾向 |
|---|---|---|
| 1 | Overlay 触发键：`Ctrl+T`（codex 同款）vs `/peek` vs `/history`？ | `Ctrl+T` + `/history` 都支持 |
| 2 | Ink 多 instance：suspend vs unmount？ | 实施时验证，倾向 suspend（主 instance 保活） |
| 3 | Static 工具默认折叠 vs 展开？ | 折叠（省空间）+ 连续合并；详情进 overlay |
| 4 | `Ctrl+O`（旧全展开）保留与否？ | overlay 内改用；主视图移除 |
| 5 | 实时子进程流式（活区 tail）做不做？ | MVP 不做（阶段 3） |
| 6 | Static resize reflow 做不做？ | MVP 不做（接受旧宽度）；/clear 后重放作 fallback |

---

## 附录 A：Ink Static 机制源码核实

> 核实版本：ink@7.1.1（`node_modules/ink/build/`）

**A.1 Static 渲染分离**（`ink.js:348`）：
```js
const { output, outputHeight, staticOutput } = render(this.rootNode, ...)
// staticOutput 单独处理（ink.js:415）：
if (hasStaticOutput) this.fullStaticOutput += staticOutput;
// → 不计入 output / outputHeight
```

**A.2 满屏判断用动态区高度**（`ink.js:754`）：
```js
const isFullscreen = isTty && outputHeight >= viewportRows;
// outputHeight 只含动态区，Static 不算
```

**A.3 Windows 满屏 clearTerminal**（`ink.js:89-112`）：
```js
if (isWindowsConsole && (wasFullscreen || isFullscreen)) return true;
// → renderInteractiveFrame 执行 ansiEscapes.clearTerminal
```

**A.4 Static items 只渲染新增**（`Static.js:9-17`）：
```js
const itemsToRender = useMemo(() => items.slice(index), [items, index]);
useLayoutEffect(() => { setIndex(items.length); }, [items.length]);
// → append-only，O(1) 增量
```

**A.5 log-update 增量重绘**（`log-update.js:48`）：
```js
stream.write(returnPrefix + ansiEscapes.eraseLines(previousLineCount) + str + cursorSuffix);
// previousLineCount = 动态区行数；只擦动态区，不碰 scrollback
```

**结论**：Static 内容不进 `outputHeight` → 动态区小 → 不满屏 → 不 clearTerminal → 光标不归位 → 可滚。这是 §4.2 的铁证。

---

## 附录 B：三项目 TUI 渲染策略速查

> 调研日期 2026-08-13，源码在 `D:\study\{codex,opencode,aider}`。

### B.1 codex（Rust + Ratatui + crossterm）

- **技术栈**：fork 了 Ratatui 的 `Terminal`（`codex-rs/tui/src/custom_terminal.rs`）+ 自建 escape 历史回放引擎（`insert_history.rs`）。
- **alt screen**：默认进，支持 `never`（inline 保 scrollback）。
- **历史**：已落定 cell 用 ANSI（`SetScrollRegion` + 反向换行 `\x1bM`）物理写进终端 scrollback（`insert_history.rs:88-257`）；**主视图历史不可交互**。
- **滚动**：inline 模式白嫖终端原生滚轮；alt 模式靠 Ctrl+T overlay pager（`pager_overlay.rs`，`scroll_offset` + 视口截断 + 键盘翻页）。
- **工具输出**：活区 `LiveCommandOutput`（head 50 + tail 50 + `+N lines`，1 MiB 上限）；Static 截到 5 行（用户 shell 50）；全量在 overlay。
- **启示**：主视图 Static 化 + overlay 承接交互，是同时满足四需求的最优解。

### B.2 opencode（TS + OpenTUI 自建）

- **技术栈**：`@opentui/core`（Zig 原生核心）+ `@opentui/solid`（SolidJS reconciler），自建渲染层。
- **alt screen**：全 REPL 进 alt；`run` 模式用 `screenMode: "split-footer"`（4 行活区 + scrollback，不进 alt）。
- **历史**：全 REPL 用 `<scrollbox>` 全量挂载（可交互）；run 模式历史死（`scrollback is immutable, footer is the only region that can repaint`）。
- **滚动**：全 REPL 自建键盘+鼠标；run 模式原生滚轮。
- **工具输出**：`collapseToolOutput(maxLines=10)` 截断 + 点击展开；子进程 stdout 走 `capture-stdout` 排队 flush。
- **启示**：OpenTUI 把 split-footer 作为一等公民；长期迁移目标。

### B.3 aider（Python + prompt_toolkit + rich）

- **技术栈**：`PromptSession`（输入行）+ `rich.Console`（输出/markdown），**完全用现成库**。
- **alt screen**：不进（inline）。
- **历史**：`rich.Console.print` 打到 stdout，死文本，**不可交互**。
- **滚动**：终端原生滚轮。
- **流式**：`MarkdownStream`（`mdstream.py`）——6 行 Live 活窗 + 稳定行 `console.print` flush 死，尾部留活区重绘。
- **启示**：穷人版 split-footer，证明思路成立（代价：历史不可交互）。

---

## 附录 C：与 M2 方案 B.4 的差异

| 维度 | M2 方案 B.4（去 Static 前） | 本设计（Static + Overlay） |
|---|---|---|
| 历史区 | `<Static>` | `<Static>`（恢复） |
| commit 时机 | 一轮结束（所有 tool finalize）才整轮推 | **渐进**：每片段（text/tool）完成即推 |
| 动态区 | streamingText + toolEntries 两分离 | 单一 active 段（streaming 或 tool-running） |
| 顺序 | text 区 / tool 区分离（错乱） | 按序 append（正确） |
| 历史展开 | Ctrl+O 主视图全展开（去 Static 后加） | overlay 内展开（Static 不可变） |
| 滚动 | 满 Windows clearTerminal → 滚不动 | 活区恒小 → 不满屏 → 可滚 |

---

## 附录 D：审阅修订记录（2026-08-13）

多角色审阅（含 `ink@7.1.1` / `loop.ts` / `TuiApp.tsx` 源码逐行核实）查出 4 个 P1 + 3 个 P2，已全部落到正文：

| 编号 | 问题 | 修订位置 | 修订内容 |
|---|---|---|---|
| **P1-1** | 「executeTools 串行 → 同时刻 1 工具」是**假命题**（readonly 工具 `Promise.all` 并行，`loop.ts:275-277`）；与用户上轮预警「工具多了会超出」同类拍脑袋 | §4.2 / §4.3.3 / §8 | `ActiveSegment` 单槽 → **有界列表**（≤3 展示 + 合并「N 个运行中」）；根治改由「行数硬上限」保证，不靠串行 |
| **P1-2** | `onToolStart` 时 tool_use input 未解析、assistant message 未进 messages，**拿不到 use** | §4.4 / §4.6 / §5 | 执行中只显 name + spinner；use 在 `onToolResult` 从 `messagesRef` 反查；「loop 零改动」改「基本不动 + 可选 onToolReady」 |
| **P1-3** | Windows `wasFullscreen\|\|isFullscreen` **曾触顶也持续触发**；触顶后 `fullStaticOutput`（累积全量历史）每帧重绘，剧闪，比 M2 更惨 | §4.2 / §6 / §8 | 软上限 → **硬常量 + 单测断言** `outputHeight ≤ viewportRows-4`；新增「触顶失败模式」警告，「永不触顶」成硬约束 |
| **P1-4** | overlay 多 instance：`suspendTerminal` 是给子进程的（非第二 Ink）；候选② unmount 要状态保活；候选① 自绘 ≈ 半个 OpenTUI | §4.5.1 / §6 / §8 | 候选 A（unmount/remount）为主、候选 B 成本说实话；实施前必 spike |
| P2-1 | §1.2 归因「光标归位顶部」不准（实为 `\x1b[3J` 擦 scrollback）；附录 A.4 行号 8-13 偏 | §1.2 / 附录 A.4 | 归因改为「每帧擦 scrollback」；行号订正 9-17 |
| P2-2 | 测试数 258 偏差；受影响漏 App/messages/loop | §7 | 改 ~272，列重写区与新增测试 |
| P2-4 | `/clear` 清 `messagesRef` 丢重放能力 | §4.8 / §8 | 加 resize reflow 兜底说明（保留快照 vs 接受不重排） |

**核心根基未被推翻**：断言 2（Static 不计 `outputHeight`，`renderer.js:27-39` 逐字确证）成立——「动态区恒小 → `isFullscreen=false` → 不发 clearTerminal → 可滚」因果链为真。修订集中在「如何保证动态区恒小」（P1-1/1-3）和「overlay 实现路径」（P1-4），属设计细化，非方向推翻。
