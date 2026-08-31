---
layer: tui
status: stable
depends_on:
  - 详设/2026-08-12_M2-TUI实施方案_待审核.md
  - 详设/2026-08-11_ECode-MVP详设_待审核.md（§5 TUI / §10 M2）
  - 规范/2026-08-11_MVP-TUI设计规范_待审核.md
---

# ECode TUI 渲染方案：最小 Static

> 日期：2026-08-13 · 状态：**草案待审阅**
> 背景：M2 去 `<Static>`（commit 638480f）后暴露两个阻断问题——① 满屏后 Windows clearTerminal 致无法滚动；② text/tool 顺序错乱。
> 方案：**最小 Static**（历史固化 + 当前轮动态可展开）。砍掉 Overlay / 自建 split-footer（YAGNI，OpenTUI 成熟前不做）。
> 前身 `Static+Overlay详设`（同日）已废弃——Overlay 在「历史不可再展开」被接受后无存在必要。
> 本文是精简版，聚焦配置 + commit 时机 + 满屏根治。

---

## 1. 问题（两症状 + 根因）

### 1.1 满屏 → Windows clearTerminal → 滚不动

`node_modules/ink/build/ink.js:89-112` 的 Windows 特例：

```js
const isWindowsConsole = process.platform === 'win32';
const shouldClearTerminalForFrame = (...) => {
  if (isWindowsConsole && (wasFullscreen || isFullscreen)) return true;  // line 100
};
// → clearTerminal = \x1b[2J（擦屏）+ \x1b[3J（擦 scrollback）+ \x1b[H
```

**元凶是 `\x1b[3J`（每帧擦 scrollback）**——历史被清，滚轮无历史可滚。去 `<Static>` 后动态区 `outputHeight` 随对话增长必然 ≥ `viewportRows` → 每帧擦 scrollback → 滚不动。

### 1.2 text/tool 顺序错乱

`TuiApp.tsx:126` 的 `assistantText` 跨整个 `runLoop` 所有 iter 累积（不重置）；`Conversation.tsx:53-54` 把 `streamingText`（全量文本）固定渲染在 `toolEntries`（全量工具）之前。真实时序 `text1 → tool → text2` 被压成 `[text1+text2] → [tool]`。

---

## 2. 方案：最小 Static（两区模型）

```
┌─ 终端原生 scrollback（滚轮自由滚）────────────────────┐
│  Static 区：<Static items={committed}>                 │
│    已完成的轮（user / assistant-text / tool-group）    │
│    收起固化，不可交互，永不重绘                         │
└────────────────────────────────────────────────────────┘
┄┄ 光标当前位置（老内容上滚进 scrollback）┄┄┄┄┄┄┄┄┄┄┄┄
┌─ 动态区（每帧 Ink 重绘，outputHeight 只算这块）────────┐
│  当前轮（唯一可展开），从上到下视觉顺序：              │
│    ① 用户输入（本轮 user message）                     │
│    ② 当前轮工具合并块（≤4 行，可展开）                 │
│    ③ GrayStreaming 流式灰字（≤3 行）                   │
│  ActivityBar + 输入框 + SlashSuggest + 底行（≤4 行）   │
└────────────────────────────────────────────────────────┘
```

**动态区 = 当前轮全部内容**（分区累积，见 §5）：① 用户输入 + ② 工具合并块 + ③ 流式灰字，按上面顺序排列。runLoop 结束 → 整轮 commit 进 Static（按 LLM 真实时序 `user→text→tool→text` 固化）→ 动态区清空。**视觉顺序固定，不随 LLM 交替抖动**；真实时序在 commit 进 Static 时还原。

**核心规则（用户定）**：
- **当前轮不固化**：动态区里唯一的一轮，可展开/收起。
- **其他轮都固化**：已完成的轮进 Static，收起形态，**不可再展开**。
- **进入下一轮自动收起**：runLoop 结束（或用户提交新输入）→ 当前轮收起 → commit 进 Static → 永久不可展开。
- 动态区只保留当前轮 + 输入/状态 → 恒小，永不满屏。

**砍掉（YAGNI）**：
- ❌ Overlay Pager——「历史不可再展开」被接受后，看历史靠滚轮（Static scrollback）即可，不需要独立 pager。
- ❌ 自建 split-footer（ANSI scroll region）——成本≈半个 OpenTUI，OpenTUI 成熟前不值得（见附录 C）。

---

## 3. 配置（用户定）

**动态区视觉顺序**（从上到下，用户定）：① 用户输入 → ② 工具合并块 → ③ 流式灰字 → ④ UI。

| 项 | 值 | 说明 |
|---|---|---|
| ① 用户输入 | **封顶 2 行**（折叠，仅动态区执行期） | 超长折叠（首 1 + 尾 1 +「↑ N 行已折叠」），复用 `foldStreamText` 机制；**防粘贴长代码撑爆动态区**（P1-A）。轮末 commit 进 Static 后**全文保留不截断**（输入体验批 2026-08-31：旧 10 行截断移除——用户消息锁死，回看自己发送的全文） |
| ② 当前轮工具合并块 | **折叠态 ≤4 行**（不随工具数增长） | 见下方超额策略；在流式灰字**上方**；展开看全 |
| ③ 流式灰字 | **3 行**（`foldStreamText` `STREAM_MAX_LINES` 5→3） | 工具块**下方**；小终端压到 2 行 |
| 当前轮展开 | 临时增高（看工具完整 input/result） | 只对当前轮；展开态存 `expandedTools: Set<id>` |
| 下一轮收起 | runLoop 结束 → 收起 commit 进 Static | `expandedTools` 清空；历史不可再展开 |
| ④ UI | ActivityBar + 输入框 + SlashSuggest + 底行 | ~4 行 |
| 动态区行数硬上限 | **≤ `viewportRows - 4`**（单测断言） | 防触顶雪崩（§6）；每项均有 fold 兜底 |

**动态区行数预算**：用户输入 ≤2（折叠）+ 工具合并 ≤4（折叠）+ 流式 3 + UI 4 = **~13 行**（硬上限 `viewportRows - 4`；展开当前轮时临时增高，下一轮回落）。

**工具合并块超额策略**（P1-B，折叠态恒 ≤4 行，不随 N 增长）：
- **表头 1 行**：`● N 个工具: name1, name2, name3`（超 3 个名字 → `name1, name2, … +M 个`）
- **摘要 2 行**：前 2 个工具的 1 行摘要（inputDigest + 状态色）
- **溢出 1 行**：`还有 M 个工具`（M = N − 2，M ≤ 0 时省略）
- **展开态**：看全部 N 个工具的摘要/详情（临时增高，当前轮可展开）

| N（本轮工具数） | 表头 | 摘要 | 溢出 | 折叠态总行 |
|---|---|---|---|---|
| 1 | 1 | 1 | — | 2 |
| 2 | 1 | 2 | — | 3 |
| 3 | 1 | 2 | 1 | 4 |
| 10 | 1 | 2 | 1 | 4 |
| 跨 iter 累积 9 | 1 | 2 | 1 | 4 |

**恒 ≤4 行**（N≤2 时更少）。展开才增高。这样「不随工具数增长」是**可强制的不变量**，不是假设。

---

## 4. 数据模型

### 4.1 messages（单一真相，复用）

`messages: Message[]`（loop 维护）是 Static 渲染源 + 日志/历史持久化源。不新增。

### 4.2 CommittedItem（Static 渲染单元，渐进 append）

```ts
type CommittedItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant-text'; id: string; text: string }
  | { kind: 'tool-group'; id: string; calls: CommittedToolCall[] }

interface CommittedToolCall {
  use: ToolUseBlock
  result: ToolResultBlock
  // 进 Static 即收起固化，无 expanded 态（不可再展开）
}
```

**连续工具合并**：无 text 间隔的连续 tool 合成一个 `tool-group`（`● N 个工具: ...` + 摘要），压缩 Static 占用。遇下一段 assistant-text 截断 group。

### 4.3 ActiveState（动态区：当前轮，分区累积）

```ts
interface ActiveState {
  /** 本轮用户输入（顶部 ①） */
  userInput: string
  /** 本轮所有工具（累积，合并块 ② 展示） */
  tools: ActiveTool[]
  /** 本轮流式文本（累积，③ 3 行折叠展示尾部） */
  streamingText: string
  /** 展开的工具 id（只对当前轮；commit 时清空） */
  expandedTools: Set<string>
}

interface ActiveTool {
  name: string                 // onToolStart 只给 name（use 此时未解析，P1-2）
  use?: ToolUseBlock           // onToolResult 后从 messagesRef 反查
  result?: ToolResultBlock
  status: 'running' | 'done' | 'error'
}
```

**动态区 = 当前轮全部内容**（分区累积，runLoop 结束才 commit，见 §5）：
- `onToolStart(name)` → `tools.push({ name, status:'running' })`（累积，合并块展示）
- `onToolResult(id,_,r)` → `tools` 对应项填 `use`（反查）+ `result` + `status`
- `onText(t)` → `streamingText += t`

**工具合并块展示**（超额策略见 §3）：`tools[]` 全部合并成一个块，折叠态恒 ≤4 行（表头 + 前 2 摘要 + 溢出提示），**不随工具数增长**（含 readonly 并行情景 `loop.ts:275-277` `Promise.all`、跨 iter 累积）。展开才看全部。故无需「单槽 vs 有界列表」之争——全合并成一块，P1-1 消解。

---

## 5. commit 调度（顺序 + 时机）

**核心：动态区累积当前轮全部内容（分区 ①②③），runLoop 结束一次性 commit 进 Static（按 LLM 真实时序）。**

```
事件                  动态区动作（累积，不 commit）           Static 动作
───────────────────────────────────────────────────────────────────────
用户提交              active.userInput = input                —
onText(t)            active.streamingText += t                —
onToolStart(name)    active.tools.push({ name, running })     —
onToolResult(id,_,r) active.tools 对应项填 use+result+status   —
                     （use 从 messagesRef 反查 id）

runLoop 结束         从 messagesRef 取本轮新增                整轮 commit：
（stop/abort/error） （user + assistant messages）           按 content blocks 真实时序渲染：
                     active 清空                             user → text → tool → text → ...
                     （userInput='', tools=[],               （收起形态固化）
                      streamingText='', expanded.clear()）   动态区只剩输入框
```

**关键（P1-2）**：
- `onToolStart(name)` 时 tool_use input 未解析、assistant message 未进 messages → 动态区工具项**只能 name + spinner**（无 input 摘要）。
- `onToolResult(id)` 时 `finally` 已执行（在 `executeTools` 之前），assistant message 已在 messages → **从 `messagesRef` 按 `id` 反查 `use`**，填入 `tools` 对应项 + 展示结果摘要。

**「进入下一轮自动收起」**：runLoop 结束 → 整轮 commit 进 Static（收起形态）→ `expandedTools` 清空 → 历史不可再展开。下一轮开始时动态区干净（只有输入框）。

**顺序保证**：commit 时从 `messages` 取 content blocks（本身有序），Static 按 `user → text1 → tool → text2 → ...` 真实时序固化。✓ 修复症状 2。**动态区的分区排列（①②③）只是当前轮的视觉简化，不影响 Static 的真实时序**——分区让“当前轮进行中”视觉稳定（不随 LLM 交替抖动），commit 时还原真实顺序。

**commit 遍历按 content block 原序**（P2-D）：重写 `messagesToItems` 时按 `message.content` 数组原序遍历（text / tool_use 交替），**不继承现有实现的「同 message 内 text 合并前置、tool 后置」假设**（`TuiApp.tsx:60-64` 依赖 loop 恰好按 `[text, ...tools]` 拼 `loop.ts:181-182`，一旦 provider 交错输出就复现症状 2）。

**中断 orphan tool 兜底**（P2-A）：`onToolStart` 已触发但 `onToolResult` 未到（mid-stream abort）→ `active.tools` 有 running 项，但 messages 里 never push（`loop.ts:183` `blocks.length>0` 不含半成品 tool_use）→ commit 时补一条「（已中断）」终态进 Static，不丢失。

---

## 6. 满屏根治（代码级）

**根基确证**（`renderer.js:27-39` 逐字核实）：Static 走独立 Output，**不计 `outputHeight`**。

```js
// ink.js:348
const { output, outputHeight, staticOutput } = render(this.rootNode, ...)
//                              ↑ 只算动态区

// ink.js:754
const isFullscreen = isTty && outputHeight >= viewportRows  // 只看动态区
```

Static 内容再多，`outputHeight` 不增长 → `isFullscreen=false` → 不发 `clearTerminal` → 增量更新（`log-update` 的 `eraseLines(动态区行数) + 重写`）→ **不打断滚轮**。

**动态区行数硬上限**（防触顶，每项均有 fold 兜底）：
- 各组件行数写死常量：用户输入 ≤2（折叠）/ 工具合并 ≤4（超额策略 §3）/ 流式 3 / SlashSuggest 最多 6。
- **单测断言**（P1-C，须 P1-A/B 落地后才能过）：构造「小终端 24 行 + **用户粘贴 50 行输入** + 多 iter 累积 9 个工具 + 流式 + 斜杠补全」极端场景，断言「动态 `outputHeight ≤ viewportRows - 4`」。userInput 折叠 + 工具超额策略是单测能过的前提——不定则必红。

> ⚠️ **触顶失败模式（必须杜绝）**：Windows 分支是 `wasFullscreen || isFullscreen`（**曾触顶也持续触发**），一旦触发每帧重写 `clearTerminal + fullStaticOutput（累积全量历史）+ outputToRender`（`ink.js:768`），长对话下 O(历史行数)/帧，剧闪卡顿，比 M2 全动态更惨。**故「永不触顶」是硬约束**，靠上面硬上限 + 单测保证。

---

## 7. 实施步骤

**阶段 1（全部，无 Overlay）**：

| # | 改动 | 文件 |
|---|---|---|
| 1 | 恢复 `<Static items={committed}>`（M2 去掉的加回来） | `Conversation.tsx` |
| 2 | `TuiApp` 状态重构：`streamingText+toolEntries` → `committed: CommittedItem[]` + `active: ActiveState` | `TuiApp.tsx` |
| 3 | commit 调度（§5）：onText/onToolStart/onToolResult/runLoop-end 的 flush 逻辑 | `TuiApp.tsx` |
| 4 | 工具合并块（tool-group，4 行）+ 连续合并 | `ToolCallView.tsx` / `toolview.ts` |
| 5 | 流式灰字 5→3 行 | `stream.ts`（`STREAM_MAX_LINES`） |
| 6 | 当前轮可展开（`expandedTools` Set）+ 下一轮 commit 时清空 | `TuiApp.tsx` |
| 7 | `/clear` 发 `clearTerminal`（清可见区）+ remount（重置 Static index） | `TuiApp.tsx` |
| 8 | 动态区行数硬上限单测 | `tests/tui/` |

**验收**：
- 长对话（50+ 轮）+ 展开当前轮，输入框打字**不被钉顶**，滚轮自由滚（症状 1 修复）。
- text1 → tool → text2 跨 iter，Static 按顺序显示（症状 2 修复）。
- 当前轮工具可展开看完整 input/result；进入下一轮后自动收起，不可再展开。
- 工具连续调用合并成一个 4 行块。
- 小终端（24 行）+ 并行工具 + 斜杠补全，动态区不触顶（单测断言）。

**测试调整**：现有约 259 测试中，`Conversation.test.tsx`(10) / `App.test.tsx`(6) / `messages.test.tsx`(6) 是重写区。`toolview.ts` 纯逻辑层复用。**新增**：① 并行工具活区有界列表不丢；② 动态区行数硬上限断言；③ commit 时序（顺序 + use 反查）；④ 下一轮收起（expandedTools 清空）。

---

## 8. 边界与风险

| 项 | 处理 |
|---|---|
| **历史不可再展开** | 接受（用户定）。看历史靠滚轮（Static scrollback）。 |
| **触顶雪崩** | 硬上限 + 单测杜绝（§6）。 |
| **readonly 工具并行** | 执行中工具有界列表（≤3 + 合并）。 |
| **Static resize 不 reflow** | MVP 接受（缩窄终端时老历史宽度旧，新消息正常）。 |
| **`/clear` scrollback 物理残留** | 接受（CLI 通病，同 bash `clear`）；可见区发 `clearTerminal` 清干净。 |
| **中断（Ctrl+C）** | loop try/finally 已固化；当前轮 flush 终态（「已中断，保留 N 行」）进 Static。**orphan tool 兜底**（P2-A）：mid-stream abort 的 running 工具（onToolStart 已触发、onToolResult 未到）补「（已中断）」终态，不丢失。 |

**取舍小结**：
- ✅ 保住：原生滚轮、满屏根治、text/tool 顺序、当前轮可展开、工具合并紧凑。
- ❌ 放弃：历史就地展开/收起（挪不出去，接受不可再展开）。
- ⚠️ 接受：Static resize 不 reflow、/clear scrollback 物理残留。

---

## 附录 A：Ink Static 源码核实（ink@7.1.1）

| 断言 | 位置 | 结论 |
|---|---|---|
| Static 不计 outputHeight | `renderer.js:26-39`（主树 `skipStaticElements:true` line 26-28，staticNode 渲到独立 Output line 30-38，outputHeight 仅主 Output line 39） | ✅ 方案根基 |
| 满屏判断用动态区高度 | `ink.js:754` `isFullscreen = isTty && outputHeight >= viewportRows` | ✅ |
| Windows 满屏 clearTerminal | `ink.js:100` `isWindowsConsole && (wasFullscreen\|\|isFullscreen)` | ✅ |
| Static append-only | `Static.js:9-17` `items.slice(index)` + `setIndex(items.length)` | ✅ O(1) 增量 |
| log-update 增量重绘 | `log-update.js:49` `eraseLines(previousLineCount) + str` | ✅ 只擦动态区 |

---

## 附录 B：三项目 TUI 渲染速查（调研 2026-08-13）

| 项目 | 主视图 | 历史可交互？ | 滚动 | 启示 |
|---|---|---|---|---|
| **codex**（Rust/Ratatui） | 历史 ANSI 物理写进 scrollback | ❌（Ctrl+T overlay 才行） | 原生滚轮 | Static 哲学极致版 |
| **opencode**（TS/OpenTUI 自建） | split-footer（4 行活区 + scrollback） | ❌（run 模式）/ ✅（全 REPL，失滚轮） | 原生/自建 | OpenTUI 是长期方向 |
| **aider**（Py/rich） | MarkdownStream（6 行活窗 + flush 死） | ❌ | 原生滚轮 | 穷人版 split-footer |

**铁律**：原生 scrollback ↔ 就地可交互历史，同区域互斥。ECode 选「原生滚轮 + 历史不可交互」（= codex inline / aider），符合最小 Static。

---

## 附录 C：OpenTUI 长期观望（不是现在）

OpenTUI（`github.com/anomalyco/opentui`，Zig 核心 + TS 绑定，12.9k star，MIT）的 `split-footer` 模式能一次性满足全部四需求（含历史可交互），是「对的最终方案」。**但现在不迁**：

| 硬伤 | 说明 |
|---|---|
| **Node FFI 不成熟** | 官方要求 Node 26.4 + `--experimental-ffi`（非 LTS，实验性）。ECode 是 Node 22 + tsx + npm。 |
| **换 Bun = 章程级变更** | 唯一稳定替代，但违反 AGENTS §5.1「统一 npm」；要重验所有原生依赖。 |
| **`@opentui/react` 零生产先例** | opencode 用 `@opentui/solid`，React 绑定无公开采用者。 |

**重新评估触发条件**（任一）：
1. Node FFI 进 stable **且**入 LTS；
2. 或 ECode 出于别的理由转 Bun；
3. 或 `@opentui/react` 出现公开生产采用者。

迁移成本（运行时就绪）：UI 层 1-2 周 + 运行时验证数天 ≈ 2-3 周（React 知识全转移，非重写）。届时 split-footer 让历史也可交互，Static 的「不可再展开」妥协自然消除。

---

## 附录 D：与旧方案（Static+Overlay）的差异

| 维度 | 旧（Static+Overlay，已废弃） | 本（最小 Static） |
|---|---|---|
| 历史可交互 | Overlay pager 里可展开 | ❌ 不可（接受） |
| Overlay Pager | 有（Ctrl+T，独立 Ink instance） | **砍** |
| 自建 split-footer | 候选 | **砍** |
| 复杂度 | 高（多 instance + 虚拟滚动） | 低（Ink `<Static>` 内置） |
| 工作量 | 2 阶段（主视图 + Overlay） | 1 阶段 |
| 动态区 | 活区恒小 | 同（~11 行） |
| 满屏根治 | ✅ | ✅（相同根基） |

**为什么砍 Overlay**：用户接受「历史不可再展开」（下一轮自动收起）。看历史靠滚轮即可，独立 pager 无存在必要（YAGNI）。Overlay 的主要价值（历史可展开）被否决后，只剩「集中看全量」——子进程长输出靠 Static 工具摘要 + LogStore 落盘查全量够用。
