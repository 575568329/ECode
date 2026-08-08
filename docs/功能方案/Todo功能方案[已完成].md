> ⚠️ **已废弃（2026-08-08）**：本方案已整合升级到 [`消息队列与交互重做方案[已完成].md`](消息队列与交互重做方案[已完成].md)（§7 Todo，含三角色审阅修正）。
> 实现以新方案为准；本文件仅作早期讨论溯源保留。

# Todo 功能方案（常驻对话下方）【已废弃 → 见消息队列与交互重做方案[已完成].md】

> 用户原话：「添加 Todo 功能，对话框常驻下方。」
> 本文只出方案，不写实现代码。设计原则遵循 CLAUDE.md §1.1（极简 / 防御式 / 关注点分离）与 §六（YAGNI / 任务分解）。
>
> 调研对象：Claude Code 源码 `D:\Study\claude-code-main`（含 TodoWriteTool + AppState + Spinner 渲染 + reminder 注入）。
> 落地对象：ECode 现状 `D:\Study\ECode`（agent loop 事件化 + Ink REPL + 声明式工具表）。

---

## 1. Claude Code TodoWrite 源码实证

### 1.1 数据模型（zod schema）

CC 的 todo 是定长三字段，没有 priority、due date、id 等额外字段——刻意极简。

`src/utils/todo/types.ts:4-18`

```ts
const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
const TodoItemSchema = z.object({
  content: z.string().min(1),       // 祈使句：what to do（"Run tests"）
  status: TodoStatusSchema(),
  activeForm: z.string().min(1),    // 现在进行时：what's happening（"Running tests"）
})
type TodoList = TodoItem[]   // 顶层就是数组，无包装
```

**关键点**：
- status 三态枚举（`pending` / `in_progress` / `completed`），无 `cancelled` / `skipped`。
- `content` 与 `activeForm` **都是必填**，prompt 里反复强调 "Always provide both forms"（`prompt.ts:151-154`、`:176-178`）。
  - `content` 用于待办态显示，`activeForm` 用于进行态显示——spinner 直接读 `currentTodo.activeForm` 作为动词（`Spinner.tsx:169`）。
- **没有 id 字段**：每次 TodoWrite 都是「整列表覆盖」，模型传完整新列表，而非增量 patch。

### 1.2 工具定义（input_schema）

`src/tools/TodoWriteTool/TodoWriteTool.ts:13-17`

```ts
inputSchema = z.strictObject({
  todos: TodoListSchema().describe('The updated todo list'),
})
```

**只有一个参数 `todos`**——全量替换语义。

`TodoWriteTool.ts:31-115` 工具核心实现要点：

| 行号 | 要点 |
|------|------|
| `:51` | `shouldDefer: true` —— 工具调用可延迟批处理 |
| `:52-54` | `isEnabled: !isTodoV2Enabled()` —— 新版 TaskCreate/TaskUpdate 已逐步替代 TodoWrite，但 v1 仍保留 |
| `:58-61` | `checkPermissions` 直接返回 `allow` —— **todo 是 read-only 工具，无需用户授权**（这一点在 `ToolSelector.tsx:53` 也印证：TodoWrite 被归入 `READ_ONLY` bucket） |
| `:62-64` | `renderToolUseMessage` 返回 `null` —— 工具调用本身不在对话历史里显示（避免噪声，渲染走 Spinner/TaskListV2 独立面板） |
| `:65-103` | `call()`：拿 `appState.todos[todoKey]` 作 oldTodos → 算 `allDone`（全部 completed）→ **若 allDone 则存空数组**（自动清空，不让"全完成"列表残留） → 写回 `appState.todos` |
| `:76-86` | **结构化 nudge**：如果关掉了一个 3+ 项的列表且没有 verification 步骤，标记 `verificationNudgeNeeded` |
| `:104-114` | `mapToolResultToToolResultBlockParam`：返回固定文案 `"Todos have been modified successfully..."`，必要时附加验证提醒 |

### 1.3 agent 何时被指示创建/更新 todo（system prompt 引导）

**两层引导**：

**第一层**：通用工具使用规范（`src/constants/prompts.ts:269-313`）

`getUsingYourToolsSection` 在启用 TodoWrite 时拼入这条 bullet（`:307-309`）：

> "Break down and manage your work with the ${taskToolName} tool. These tools are helpful for planning your work and helping the user track your progress. **Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.**"

REPL 模式同样的 bullet（`:279-281`）。

**第二层**：工具自身的 prompt（`src/tools/TodoWriteTool/prompt.ts:3-181`）

PROMPT 极详尽，含正反例（`prompt.ts:29-142`），关键约束（`prompt.ts:144-180`）：

1. **何时用**：3+ 步任务 / 复杂任务 / 用户列了多个任务 / 收到新指令时立即建 / 开始前标 in_progress / 完成后立即标 completed
2. **何时不用**：单步 trivial 任务 / 纯信息问答 / 一步能搞定的
3. **任务管理铁律**：
   - 实时更新状态
   - **恰好一个 in_progress**（不多不少）
   - 完成当前任务再开下一个
   - 失败/阻塞时**保持 in_progress**，新建子任务描述问题，**绝不把失败任务标 completed**
   - 不再相关的任务**整个删掉**（不是标 cancelled）

**第三层**：reminder 自动注入（`src/utils/attachments.ts:254-257, 3290-3317`）

如果模型连续 10 轮没调 TodoWrite、且连续 10 轮没收到 reminder，系统**自动把当前 todo 列表作为 attachment 注入上下文**（`todo_reminder` 类型，`:483-486`）。这是一个被动安全网——避免模型建完列表就忘。

```ts
// attachments.ts:254-257
export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const
```

### 1.4 渲染：常驻 Spinner 区（动态区，非历史流）

CC 的 todo 渲染分两处：

**A. Spinner 内嵌（默认视图）** —— `src/components/Spinner.tsx:161-171, 280-286`

- 找出当前 in_progress 项：`tasksV2?.find(t => t.status !== 'pending' && t.status !== 'completed')`（`:162`）
- spinner 文案 = `currentTodo.activeForm ?? currentTodo.subject ?? randomVerb` + `…`（`:169-171`）
- 完整列表只在 `expandedView === 'tasks'` 时展开为 `<TaskListV2>`（`:109, :282-285`）

**关键设计哲学**：默认视图**只显示当前进行中的那一条**作为 spinner 动词，避免 todo 列表抢占对话注意力；用户主动展开（`expandedView`）才看到全列表。

**B. TaskListV2 组件**（`src/components/TaskListV2.tsx`，新版 v2 用）

未精读（v2 已用 TaskCreate/TaskUpdate 替代 TodoWrite，与 v1 思路一致：按 status 渲染符号 + 缩进 + activeForm）。

**渲染位置**：所有渲染都在 `<Static>` 历史**之下**的动态区，与 spinner 同层。**不在历史消息流里**——因为 `renderToolUseMessage` 返回 `null`（`TodoWriteTool.ts:62-64`）。

### 1.5 与 agent loop 集成：模型驱动，非固定流程

**完全模型驱动**：
- agent loop 本身**没有**任何「每轮强制调 TodoWrite」的代码
- 调用时机全靠 system prompt + 工具 prompt + reminder 三层软引导
- 工具执行就是 `call()` 写 `appState.todos[todoKey]`，与其他工具同通道

**todoKey**（`TodoWriteTool.ts:67`）：`context.agentId ?? getSessionId()` —— 主线 agent 用 sessionId，子 agent 用自己的 agentId 隔离，多 agent 不串。

### 1.6 存储：AppState 内存态，不进 session 文件

`src/state/AppStateStore.ts:220`：

```ts
todos: { [agentId: string]: TodoList }
```

**关键判断**：
- AppState 是**运行时内存态**（Zustand store），**不直接落盘到 session JSON**
- 但 `src/utils/sessionRestore.ts:56-57, 77-97` 有 `extractTodosFromTranscript` —— 从历史 messages 里**反推**重建 todo（扫最后一条 TodoWrite tool_use 的 input）。也就是说：**持久化靠的是 messages 历史里的 TodoWrite tool_use 调用记录本身**，AppState 只是缓存。
- `src/utils/messages.ts` 也含 todo 相关处理（与历史压缩/裁剪协作）。

---

## 2. ECode 落地设计

### 2.1 总体策略：对齐 CC，最小侵入

ECode 的 agent loop / 工具注册 / UI 都已是声明式 + 事件化结构，加 Todo 的最小切口：

| 切口 | CC 对应 | ECode 落点 |
|------|---------|-----------|
| 工具定义 | `tools/TodoWriteTool/` | `src/tools/todo-write.ts`（新建）+ `registry.ts` 加一条 |
| 数据模型 | `utils/todo/types.ts` | `src/tools/todo-write.ts` 内导出 `TodoItem` / `TodoList` / `TodoStatus` |
| system prompt 引导 | `constants/prompts.ts` 拼接 + `TodoWriteTool/prompt.ts` | `src/system-prompt.ts` 的 `TOOL_GUIDE` 加一段 + 工具 description 承载详细 prompt |
| AppState | `AppStateStore.todos[agentId]` | ECode 无 AppState 概念——**复用 session.ts 加字段 + 事件流**（见 §2.5） |
| 渲染 | Spinner 内嵌 + TaskListV2 | `src/ui/todo-panel.tsx`（新建）+ `app.tsx` 布局插入 |
| reminder 自动注入 | `attachments.ts` 每 10 轮 | **MVP 不做**（YAGNI，见 §3） |

### 2.2 todo 数据模型（TS 类型）

放 `src/tools/todo-write.ts` 顶部导出：

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** 祈使句：要做什么（"跑测试"），用于 pending/completed 态显示 */
  content: string;
  /** 当前状态 */
  status: TodoStatus;
  /** 现在进行时：正在做什么（"正在跑测试"），in_progress 态显示在 spinner 旁 */
  activeForm: string;
}

export type TodoList = TodoItem[];
```

**对齐 CC 三字段，不增不减**（不引入 priority/id/createdAt——YAGNI）。
- TS strict 兼容：用字面量联合类型而非 enum（避免运行时注入 + noUnusedLocals 友好）。
- ECode 工具参数是 JSON Schema（`ToolDefinition.parameters`），TS 类型仅用于工具实现内部强类型。

### 2.3 TodoWrite 工具定义

放 `src/tools/todo-write.ts`，挂在 `registry.ts`。

**name**：`todo_write`（ECode 命名风格是 snake_case，对齐 `read_file` / `edit_file`；CC 用 `TodoWrite` camelCase，但不强制对齐）。

**description**（即 CC 的 PROMPT 精简中文版，承载何时用/何时不用/状态铁律）：

```text
管理当前会话的任务清单（todo list）。本工具用于规划和追踪多步任务的进度，
让用户实时看到你在做什么、还剩什么没做。

## 何时使用
- 复杂多步任务（≥3 个明确步骤）
- 用户一次给了多个任务（列表/逗号分隔）
- 收到新指令时立即建表
- 开始一个任务前：先标 in_progress（同一时刻恰好一个 in_progress）
- 完成一个任务后：立即标 completed（不要攒着批量标）

## 何时不用
- 单步 trivial 任务
- 纯信息问答（"xx 怎么用"）

## 状态铁律
- 恰好一个 in_progress（不能 0 个也不能多个）
- 完成任务立即标 completed
- 失败/阻塞时保持 in_progress，新建子任务描述问题，绝不把失败任务标 completed
- 不再相关的任务整个删掉（不要标 cancelled，本工具无该状态）

## 字段约定
- content：祈使句，描述要做什么（"跑测试"）
- activeForm：现在进行时，描述正在做什么（"正在跑测试"）
- 两者都必填

## 全量替换语义
每次调用传完整新列表（不是增量 patch）。
```

**parameters（JSON Schema）**：

```jsonc
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "description": "完整的任务列表（全量替换，不是增量）",
      "items": {
        "type": "object",
        "properties": {
          "content":    { "type": "string", "description": "祈使句：要做什么" },
          "status":     { "type": "string", "enum": ["pending", "in_progress", "completed"] },
          "activeForm": { "type": "string", "description": "现在进行时：正在做什么" }
        },
        "required": ["content", "status", "activeForm"]
      }
    }
  },
  "required": ["todos"]
}
```

**execute 实现**（伪代码）：

```ts
export function executeTodoWrite(input: { todos: TodoList }): ToolResult {
  // 参数校验：恰好一个 in_progress（软约束，违反时返回提示让模型重试，不抛错）
  const inProgressCount = input.todos.filter(t => t.status === 'in_progress').length;
  if (input.todos.length > 0 && inProgressCount > 1) {
    return {
      content: '任务列表中同时有多个 in_progress，请保持恰好一个。',
      isError: true,
    };
  }
  // 全部 completed → 视为清单完成，自动清空（对齐 CC TodoWriteTool.ts:69-70）
  const allDone = input.todos.length > 0 && input.todos.every(t => t.status === 'completed');
  const normalized = allDone ? [] : input.todos;

  // 状态写入：经事件流回 UI（详 §2.5）
  emitTodosUpdated(normalized);

  return {
    content: '任务清单已更新。请继续按清单推进，完成后及时标记。',
    isError: false,
  };
}
```

**属性**：
- `dangerous`：**不设**（todo 是纯内存写，无副作用，对齐 CC 归为 read-only，不触发 permissionGate）。
- `parallelizable`：不设（与其他工具并行无副作用，但 ECode 当前没用到该字段，YAGNI）。

### 2.4 常驻 UI 组件：位置与视觉

#### 2.4.1 位置（关键决策）

ECode 当前 `app.tsx:248-280` 布局：

```
┌─────────────────────────────────┐
│ WelcomeScreen 或 ChatView       │  ← <Static> 历史 + 动态区
├─────────────────────────────────┤
│ SessionPicker / PermissionDialog│
│   / InputBar                    │  ← 交互层（互斥三选一）
├─────────────────────────────────┤
│ StatusBar                       │  ← 恒显底部
└─────────────────────────────────┘
```

**TodoPanel 插入位置**：`ChatView` 与交互层之间，常驻。

```
┌─────────────────────────────────┐
│ WelcomeScreen 或 ChatView       │
├─────────────────────────────────┤
│ TodoPanel（新增，常驻）         │  ← 空列表时不渲染
├─────────────────────────────────┤
│ SessionPicker/Permission/InputBar│
├─────────────────────────────────┤
│ StatusBar                       │
└─────────────────────────────────┘
```

**为什么不在 ChatView 内**：ChatView 的 `<Static items={completedMessages}>` 是 append-only（`chat-view.tsx:105`），一旦写入不再 diff。todo 需要随每轮工具调用实时刷新状态，必须留在动态区。CC 也是这个思路——TodoWrite 的 `renderToolUseMessage` 返回 `null`（`TodoWriteTool.ts:62-64`），不进历史流。

**为什么在 InputBar 之上而非之下**：
- 用户原话「对话框常驻下方」中的「对话框」最合理的解读是「对话区（聊天历史）」——todo 常驻在对话区下方。
- 放 InputBar 之上：用户输入时 todo 仍可见（输入过程中也能看到进度）。
- 放 InputBar 之下（夹在 InputBar 和 StatusBar 之间）：todo 会被输入光标顶到再下一行，视觉割裂。

#### 2.4.2 视觉规范

新建 `src/ui/todo-panel.tsx`，复用 `theme.js`（`T` token）与 `borders.js` 的 `leftBorder`。

**整体**：单行标题 + N 行任务，左边框（与 BlockTool/Warning 同款 `leftBorder`），无边框盒子（避免抢眼）。

```
☐ todos (1/3)
  ▸  正在跑测试            ← in_progress（brand 色 + 闪 spinner 隐喻）
  ○  修复 bug              ← pending（muted）
  ✓  读取文件              ← completed（success 色 + 删除线效果）
```

**各 status 符号与配色**（对齐 ECode 现有 `SYMBOLS`，参考 `tool-panel.tsx:108-109` 的 success/error 配色思路）：

| status | 符号 | 颜色 | 备注 |
|--------|------|------|------|
| `pending` | `○` | `T.muted` | 灰色，弱化 |
| `in_progress` | `▸` | `T.brand` | 青色高亮，唯一焦点；可选加 `Spinner`（复用 `./spinner.tsx`） |
| `completed` | `✓` | `T.success` | 绿色；可选加 strikethrough（Ink `<Text strikethrough>` 支持） |

**标题行**：`☐ todos (done/total)`，`done/total` 用 `T.muted`。
- 例：`☐ todos (1/3)` 表示 3 项中完成 1 项。
- 空列表 → 整个 TodoPanel 不渲染（避免空面板占行）。
- 全部完成 → 经 `executeTodoWrite` 已自动清空（§2.3），所以面板自然消失，无需"庆祝态"。

**单行模式**（CC 思路借鉴）：当只有 1 个 in_progress、其他都 pending 时，可只显示那一行 + 总数。MVP 先不做，全列表常驻即可（YAGNI）。

#### 2.4.3 与 spinner 的关系（避免重复）

ECode 现有 `ToolRunning`（`tool-panel.tsx:23-33`）会在工具执行时显示 spinner + 工具名。TodoPanel 的 in_progress 行也考虑加 spinner 会**双闪冲突**。

**决策**：TodoPanel 的 in_progress 行**不加 spinner**，用纯符号 `▸` + brand 色高亮即可。spinner 是工具执行的视觉信号，让给它；TodoPanel 只表达"当前在哪一步"。这比 CC 更克制（CC 的 spinner 文案直接用 `activeForm`，但 ECode 已有独立的工具执行 spinner）。

### 2.5 Agent 集成：system prompt 引导 + 事件流回写

#### 2.5.1 system prompt 引导（`src/system-prompt.ts`）

在 `TOOL_GUIDE`（`system-prompt.ts:24-29`）尾部追加一条：

```text
- **todo_write**：管理任务清单。复杂多步任务（≥3 步）或用户给多个任务时，
  主动建清单追踪进度。开始任务前标 in_progress（恰好一个），完成后立即标 completed。
  详见工具自身 description。
```

不重复整个工具 description（避免 system prompt 膨胀），详细规则放工具 description 里——provider 会把 description 也发给 LLM。

#### 2.5.2 todo 状态如何从 agent core 流到 UI

ECode 当前 agent → UI 的事件流是 `AgentEvent`（`agent-events.ts:23-45`）。加一个新事件：

```ts
// agent-events.ts 扩展
| { type: 'todos_updated'; todos: TodoList }
```

**agent.ts 集成点**（`agent.ts:339-415` 工具执行循环）：

在 `executeTool(tc.name, tc.input)` 拿到 result 后，**如果是 `todo_write`**，额外 yield 一个 `todos_updated` 事件：

```ts
// agent.ts 内（伪代码，在 tool_result yield 之后或之前）
if (tc.name === 'todo_write') {
  const parsed = input.todos as TodoList;  // 已通过 executeTodoWrite 校验
  yield { type: 'todos_updated', todos: parsed };
}
```

**为什么用事件而非返回值**：ECode 的 `executeTool` 签名是 `(name, input) => Promise<ToolResult>`（`executor.ts:9-34`），改签名为返回副作用会污染所有工具。事件流是已有的 agent → UI 通道，最小侵入。

**或者更解耦的方案**（推荐）：在 `executeTodoWrite` 内部直接调一个注入的回调 `onTodosUpdated`。但 ECode 当前工具 execute 签名不支持回调注入。**MVP 走「agent.ts 里 if name === 'todo_write'」即可**——一处特判，文档化，YAGNI。

#### 2.5.3 UI 状态：use-agent-stream + reduce-agent-event

`StreamState`（`ui/types.ts`）加字段：

```ts
todos: TodoList;  // 初始 []
```

`reduce-agent-event.ts` 加 case：

```ts
case 'todos_updated':
  return { ...state, todos: event.todos };
```

`use-agent-stream.ts` 的 `UseAgentStreamReturn` 暴露 `todos`，`clear` / `switchSession` 重置时一并清空。

#### 2.5.4 TodoPanel 渲染

`app.tsx:248-280` 的 JSX 在 `ChatView` 与交互层之间插入：

```tsx
{started && api.todos.length > 0 && <TodoPanel todos={api.todos} />}
```

`started` 守卫确保欢迎屏期间不显示；`length > 0` 守卫确保空清单不留空行。

### 2.6 存储：是否进 session？

**进 session（持久化）**，但仅作为重建依据，运行时状态走事件流。

**方案**：在 `ECodeSession`（`session.ts:27-35`）加可选字段：

```ts
export interface ECodeSession {
  // 现有字段...
  todos?: TodoList;  // 最后一次 todo_write 的快照
}
```

**写入时机**：与现在每轮末 `persistSession(buildSession())` 一致（`agent.ts:444`），`buildSession` 把当前 `todos` 一起带上。

**加载时机**：`/resume` 载入历史会话时（`app.tsx:221-237`），把 `session.todos` 作为初始 `todos` 注入 `switchSession`。

**为什么不靠 messages 历史反推（CC 的做法）**：
- CC 的 `extractTodosFromTranscript`（`sessionRestore.ts:77-97`）扫历史 tool_use 反推——准确但要扫全历史，复杂度高。
- ECode 的 session 结构简单（直接 JSON），**直接存最后快照**更简单可靠。
- 风险：session 文件结构变化（加可选字段）。但加可选字段不破坏旧 session 兼容（旧文件缺该字段，`session.todos` 为 undefined，UI 显示为空）。

**不进 messages**：todo_write 的 tool_use / tool_result **仍然进 messages 历史**（与其他工具一致，agent loop 自动处理），这部分不变。`todos?: TodoList` 字段只是 UI 的快速恢复缓存。

**与上下文压缩的关系**（见 §4 风险）：`maybeCompress`（`agent.ts:255-273`）压缩历史时，TodoWrite 的 tool_use 调用可能被摘要掉。压缩后，模型可能"忘"了自己建过 todo——这正是 CC reminder 机制（§1.3 第三层）要解决的。MVP 先不处理，记入开放问题。

---

## 3. MVP 范围（YAGNI）

### 3.1 MVP 必做（P0）

| 项 | 文件 | 说明 |
|----|------|------|
| 数据模型 + 工具 | `src/tools/todo-write.ts`（新建） | §2.2 / §2.3 |
| registry 注册 | `src/tools/registry.ts` | 加一条 |
| system prompt 引导 | `src/system-prompt.ts` | `TOOL_GUIDE` 加一段 |
| 事件扩展 | `src/agent-events.ts` + `src/agent.ts` + `src/ui/types.ts` + `src/ui/reduce-agent-event.ts` + `src/ui/use-agent-stream.ts` | §2.5 |
| TodoPanel 组件 | `src/ui/todo-panel.tsx`（新建） | §2.4 |
| 布局插入 | `src/ui/app.tsx` | §2.4.1 |
| session 持久化 | `src/session.ts` + `buildSession` | §2.6 加可选字段 |
| 单元测试 | `tests/tools/todo-write.test.ts`（新建） | 校验 in_progress 计数 / allDone 清空 / 错误返回 |

### 3.2 MVP 不做（P1 / P2，后续迭代）

| 项 | 理由 |
|----|------|
| **reminder 自动注入**（CC 每 10 轮把 todo 塞回上下文） | 复杂（要扫历史计轮数 + 注入 attachment），MVP 阶段模型在 system prompt 引导下基本会主动维护 |
| **单行紧凑模式**（CC 默认只显示 in_progress 那条） | UI 优化，先全列表常驻，看用户反馈再优化 |
| **todo 编辑历史/diff** | YAGNI，全量替换语义不需要 diff |
| **priority / due date / tags** | CC 也没做，刻意极简 |
| **多 agent 隔离（todoKey）** | ECode 当前没有子 agent 概念，主线 sessionId 即可 |
| **verification nudge**（CC 检测 3+ 项关闭无验证步骤时提醒） | ECode 没有验证 agent，不适用 |
| **strikethrough 完成态** | 视觉糖，先纯颜色区分 |
| **/todos 斜杠命令**（手动查看/编辑） | YAGNI，常驻面板已可见 |

### 3.3 一个迭代周期可交付的粒度

按 §六任务清单模板，MVP 拆为 3 个子任务，每个 30-90min：

1. **P0 | 工具 + 数据模型 + 单测**（无 UI 依赖，先红绿）| 1h
2. **P0 | 事件流 + reducer + use-agent-stream 桥接** | 1h
3. **P0 | TodoPanel 组件 + app.tsx 布局 + session 持久化** | 1.5h

总计 ~3.5h，符合 §6.4 复杂度门槛（< 4h）—— **不启动正式分解流程**，直接 TDD。

---

## 4. 风险与开放问题

### 4.1 风险

| 风险 | 等级 | 说明 | 缓解 |
|------|------|------|------|
| **模型不主动调 todo_write** | 中 | system prompt 引导是软约束，模型可能"忘了"用 | MVP 接受；后续做 reminder（CC 的 10 轮安全网）|
| **上下文压缩丢 todo** | 中 | `maybeCompress`（`agent.ts:255-273`）摘要历史时，TodoWrite 的 tool_use 可能被压掉 → 模型"忘"了建过 todo | MVP 接受；P1 加 reminder 自动注入（即使被压，reminder 会把当前 todo 重新塞回去）|
| **常驻面板挤占垂直空间** | 低 | 终端行数有限，todo 多了会挤压 ChatView | 单行任务（content ≤ 40 字符）+ 全列表一般 < 8 行，可接受；后续做单行紧凑模式 |
| **Static 约束误判** | 低 | 若误把 TodoPanel 放进 `<Static>`，append-only 会导致状态无法刷新 | §2.4.1 已明确放动态区，code review 检查 |
| **全量替换语义被模型误用为增量** | 低 | 模型可能只传新增项，漏掉旧项 | description 明确写"全量替换"+ execute 里 in_progress 计数校验兜底（不致命，返回提示让模型重试） |
| **session 字段兼容性** | 低 | 旧 session 文件无 `todos` 字段 | 字段设可选，加载时 `?? []` |
| **DeepSeek/GLM 等模型对中文 prompt 的工具调用稳定性** | 中 | ECode 默认走 DeepSeek 兼容端点，非 Claude，对长 prompt + JSON Schema 工具的遵循度需验证 | 测试驱动（§5）；若不稳定，强化 description 措辞或加 few-shot |

### 4.2 开放问题

1. **todo 是否应作为独立 attachment 主动注入上下文？**
   - CC 做（`attachments.ts:3290-3317`）：每 10 轮自动注入当前 todo。
   - ECode MVP 不做。但若实测模型"建完就忘"频发，这是第一个要补的。
   - 决策点：MVP 跑一周后看用户反馈再定。

2. **多 in_progress 是否要硬阻拦？**
   - CC 不硬拦（prompt 说"恰好一个"，但工具不校验）。
   - ECode MVP **软拦**（execute 里 `> 1` 时返回 isError 提示重试）。
   - 开放：是否改为只警告不拦？倾向保留硬拦——失败可重试成本低，硬拦能更快纠正模型行为。

3. **TodoWrite 是否应该让用户也能调用（/add-todo /-done）？**
   - CC 是模型独占工具。
   - ECode MVP 不开用户侧入口（YAGNI）。
   - 后续若用户反馈"想手动加一条"，再考虑 `/todo` 斜杠命令。

4. **任务清单的命名空间**
   - CC 用 `todos[agentId]`，多 agent 隔离。
   - ECode 单 agent，sessionId 即可；但若 M5 加子 agent / fork，需要回来加 key。
   - MVP 不考虑。

5. **completed 任务的"残留显示"**
   - 全部 completed 时 CC 自动清空（`TodoWriteTool.ts:69-70`），ECode 沿用。
   - 但中途状态：5 项有 3 项 completed，是否折叠已完成项？MVP 全展开。后续可考虑折叠到「✓ 3 已完成」一行。

---

## 5. 验收标准

### 5.1 功能验收（用户视角）

| # | 场景 | 预期 |
|---|------|------|
| A1 | 给 agent 一个 3+ 步任务（如「读 X、改 Y、跑测试」） | agent 第一轮主动调用 todo_write 建清单，TodoPanel 出现在对话区下方 |
| A2 | agent 开始第一项 | 该项标为 in_progress（`▸` brand 色），其他 pending |
| A3 | agent 完成第一项、开始第二项 | 第一项变 `✓` success 色，第二项变 `▸` |
| A4 | 全部完成 | agent 末次 todo_write 全 completed → TodoPanel 消失（清空） |
| A5 | 给 agent 一个 trivial 单步任务（「打印 hello」） | agent **不**调 todo_write，TodoPanel 不出现 |
| A6 | `/resume` 切到含 todo 的历史会话 | TodoPanel 从 session.todos 恢复显示 |
| A7 | 中断 + 续接（同一会话多轮） | TodoPanel 跨轮保持，状态不丢 |

### 5.2 工具层验收（单测）

`tests/tools/todo-write.test.ts`（新建）：

| # | 测试名（`should_X_when_Y`） | 断言 |
|---|------|------|
| T1 | `should_accept_valid_todo_list` | 正常列表 → isError=false，返回成功文案 |
| T2 | `should_reject_multiple_in_progress` | 2 个 in_progress → isError=true，错误文案含"多个 in_progress" |
| T3 | `should_auto_clear_when_all_completed` | 全 completed → emit 空列表（清空） |
| T4 | `should_reject_empty_content` | content 空串 → isError=true（参数校验，可走 executor 通用层或工具内） |
| T5 | `should_reject_invalid_status` | status 非 enum 值 → isError=true |
| T6 | `should_allow_empty_list` | todos=[] → isError=false（清空操作合法） |

### 5.3 UI 层验收（组件测）

`tests/ui/todo-panel.test.tsx`（新建）：

| # | 测试名 | 断言 |
|---|------|------|
| U1 | `renders nothing when todos empty` | `todos=[]` → 组件不渲染任何输出 |
| U2 | `renders all three statuses with correct symbols` | 给定 3 项各态 → 含 `○` / `▸` / `✓` 符号 |
| U3 | `shows done/total in title` | 标题行含 `(1/3)` 计数 |
| U4 | `uses brand color for in_progress` | in_progress 行的 `<Text color>` = `T.brand` |

### 5.4 集成验收

| # | 场景 | 预期 |
|---|------|------|
| I1 | 跑现有 `tests/agent-stream.test.ts` 全用例 | 不回归（todo_write 工具新增不影响既有工具）|
| I2 | 端到端：`npm run dev -- "实现一个 hello world 函数并加测试"` | agent 建清单 → 执行 → TodoPanel 实时更新 → 全完成消失 |
| I3 | `npm run build` | tsc strict 编译通过（无 any、无未用变量）|

### 5.5 非目标（明确排除）

- 不做 reminder 自动注入（开放问题 §4.2-1）
- 不做用户侧编辑入口（开放问题 §4.2-3）
- 不做单行紧凑模式（P1）
- 不做多 agent 隔离（开放问题 §4.2-4）

---

## 附录 A：CC 关键源码索引（带 file:line）

| 内容 | 位置 |
|------|------|
| TodoWrite 工具定义 | `src/tools/TodoWriteTool/TodoWriteTool.ts:31-115` |
| TodoWrite 工具名常量 | `src/tools/TodoWriteTool/constants.ts:1` |
| TodoWrite 详细 prompt（何时用/不用/铁律） | `src/tools/TodoWriteTool/prompt.ts:3-181` |
| TodoWrite 工具 description（简短） | `src/tools/TodoWriteTool/prompt.ts:183-184` |
| Todo 数据模型 schema | `src/utils/todo/types.ts:4-18` |
| 全局工具规范里拼入 todo bullet | `src/constants/prompts.ts:270, 307-309` |
| REMOVED_by_v2 开关（`isTodoV2Enabled`） | `src/tools/TodoWriteTool/TodoWriteTool.ts:7, 52-54` |
| Spinner 内嵌 todo（currentTodo.activeForm） | `src/components/Spinner.tsx:162, 169-171` |
| Spinner 展开为 TaskListV2 | `src/components/Spinner.tsx:109, 282-285` |
| AppState.todos 存储 | `src/state/AppStateStore.ts:220` |
| call() 写 appState.todos[todoKey] | `src/tools/TodoWriteTool/TodoWriteTool.ts:66-94` |
| allDone 自动清空 | `src/tools/TodoWriteTool/TodoWriteTool.ts:69-70` |
| todoKey = agentId ?? sessionId | `src/tools/TodoWriteTool/TodoWriteTool.ts:67` |
| renderToolUseMessage 返回 null（不进历史） | `src/tools/TodoWriteTool/TodoWriteTool.ts:62-64` |
| checkPermissions 直接 allow（read-only） | `src/tools/TodoWriteTool/TodoWriteTool.ts:58-61` |
| 归类 READ_ONLY bucket | `src/components/agents/ToolSelector.tsx:53` |
| verification nudge 触发 | `src/tools/TodoWriteTool/TodoWriteTool.ts:76-86, 104-114` |
| reminder 自动注入配置 | `src/utils/attachments.ts:254-257` |
| reminder 注入逻辑 | `src/utils/attachments.ts:3290-3317` |
| reminder attachment 类型 | `src/utils/attachments.ts:483-486` |
| 从历史反推 todo 重建 | `src/utils/sessionRestore.ts:56-57, 77-97` |

## 附录 B：ECode 落点索引

| 内容 | 位置（新增/修改） |
|------|------|
| 数据模型（TodoItem/TodoList/TodoStatus） | `src/tools/todo-write.ts`（新） |
| 工具定义 + execute | `src/tools/todo-write.ts`（新） |
| 工具注册 | `src/tools/registry.ts`（改，加一条） |
| system prompt 引导 | `src/system-prompt.ts`（改 TOOL_GUIDE） |
| 事件类型扩展 | `src/agent-events.ts`（改，加 `todos_updated`）|
| agent yield 事件 | `src/agent.ts`（改，工具执行后特判 todo_write）|
| StreamState 加 todos | `src/ui/types.ts`（改）|
| reducer 处理新事件 | `src/ui/reduce-agent-event.ts`（改）|
| hook 暴露 todos | `src/ui/use-agent-stream.ts`（改）|
| TodoPanel 组件 | `src/ui/todo-panel.tsx`（新）|
| 布局插入 | `src/ui/app.tsx`（改，ChatView 与交互层之间）|
| session 加 todos 字段 | `src/session.ts`（改 ECodeSession 加可选字段）|
| 工具单测 | `tests/tools/todo-write.test.ts`（新）|
| UI 单测 | `tests/ui/todo-panel.test.tsx`（新）|
