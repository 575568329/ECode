# ECode 项目代码审查报告

> 审查日期：2026-08-07
> 审查范围：`src/` 全量（45 文件 / ~5600 行）+ `tests/` 全量（44 文件 / ~5400 行）+ `docs/memory/` + `CLAUDE.md` + `00-开发规划.md`
> 审查方法：实读全部源码 + 跑 `npx tsc --noEmit`（clean）+ 跑 `npx vitest run`（43 文件 400 测试全绿）
> 严重度：🔴高（影响功能正确性/安全/可交付）/ 🟡中（影响可维护性/体验）/ 🟢低（打磨项）

---

## 一、项目概览

### 1.1 项目定位

ECode 是用 TypeScript + Node.js 从零**手写**的 AI coding agent（**开源产品**，对标 Claude Code）。单包 CLI，核心是手写的 agent loop（不用 LangGraph 等框架）。当前处于 M3.5（交互式 CLI）阶段，已完成沉浸 Ink REPL、斜杠命令、流式渲染、工具折叠、Ctrl+O pager、会话切换。

### 1.2 架构骨架

```
src/index.ts                   CLI 入口（parseArgs → 三模式分流：REPL/oneshot/usage）
  ├─ runAgent / runAgentStream [agent.ts]  agent loop 心脏（事件化 generator）
  │   ├─ consumeStream                     流式 chunk 消费（text_delta 逐 chunk yield）
  │   ├─ maybeCompress        [context-manager.ts]  上下文压缩门面（trim→summary 级联）
  │   ├─ executeTool          [tools/executor.ts]   声明式分发（无 switch）
  │   ├─ permissionGate 注入              dangerous 工具审批
  │   └─ persistSession       [session.ts]          落盘（原子写 + 失败降级）
  ├─ Provider 层 [providers/]
  │   ├─ types.ts                         ECode 内部统一格式（判别联合）
  │   ├─ transform.ts                     内部格式 ↔ Anthropic/OpenAI 双向翻译
  │   ├─ claude.ts / openai.ts            各自 SDK 包装
  │   └─ config.ts / factory.ts           config.json 驱动 + 工厂
  ├─ Tools 层 [tools/]                    read_file/bash/edit_file/grep/glob
  ├─ UI 层 [ui/]                          Ink + React 19
  │   ├─ app.tsx                          REPL 主体（组合 + 斜杠分发 + 双击退出）
  │   ├─ use-agent-stream.ts              runAgentStream ↔ React state 桥
  │   ├─ reduce-agent-event.ts            纯函数 reducer（可单测）
  │   ├─ chat-view/input-bar/...          各 UI 组件
  │   └─ format-transcript / pager        Ctrl+O 转录
  └─ 共享：runtime-logger / session / permission / retry / token-counter / system-prompt
```

**分层亮点**：
- **Provider 抽象**（M2）：agent loop 不 import 任何 SDK，只依赖 `ModelProvider` 接口 + 内部格式；换模型 = 换 Provider 实例。`transform.ts` 纯函数双向翻译，无副作用，易测。
- **UI ↔ Core 解耦**（M3.5）：`runAgentStream` 是 `AsyncGenerator<AgentEvent>`，UI 无关；reducer 纯函数；UI 通过 hook 消费。
- **关注点分离**：session.ts 纯数据层（零 LLM 依赖）；reduce-agent-event.ts 纯函数状态机（无 React 依赖）。

### 1.3 代码规模

| 层 | 文件数 | 行数 |
|---|---|---|
| `src/`（不含 ui） | 23 | ~3100 |
| `src/ui/` | 22 | ~2500 |
| `tests/` | 44 | ~5400 |
| **合计** | **89** | **~11000** |

### 1.4 测试规模

- **43 测试文件 / 400 测试用例全绿**（`npx vitest run` 27.58s）
- 覆盖核心路径：agent loop / context-manager（trim+级联+forceCompact+熔断）/ session 往返 / pairing 完整性 / provider 翻译 / config 解析 / reducer / REPL 人肉驱动
- 测试哲学成熟：`docs/memory/preferences.md` 明文写"防假绿 5 条"，`tests/ui/repl-human.test.tsx` 注释里有 mutation 验红 checklist

---

## 二、审查发现（按严重度排序）

### 🔴 高严重度

#### 🔴-1 `forceCompact` / `isContextWindowError` 已实现且测试覆盖，但 **agent.ts 从未调用** —— L3 响应式恢复实为死代码

- **位置**：`src/context-manager.ts:353-397`（定义）+ `tests/context-resilience.test.ts`（20 测试）+ `src/agent.ts:459-484`（catch 块未调用）
- **问题**：
  - `isContextWindowError(err)` 覆盖 GLM/Anthropic/OpenAI 多协议措辞，`forceCompact` 实现激进 trim+summary+熔断，两者都导出了，测试也都过——但 `grep -rn "forceCompact\|isContextWindowError" src/` 显示**只有 context-manager.ts 自身引用它们**。
  - `agent.ts:459` 的 catch 块只处理 `AbortError`，其它异常（含 API 400 context-window 错）一律 `yield { type: 'error' }` 终止 loop。
  - 后果：用户高频触发的"API 报超限→agent 死"死局（`docs/memory/debugging.md #005` 描述的现象）**没有任何恢复路径**。`withRetry` 把 400 当不可重试直接抛（`retry.ts:33`），agent 死。
  - **更严重的是文档/记忆失真**：`docs/memory/debugging.md #005` 写"已实现 L3 响应式恢复"，`docs/memory/MEMORY.md` 写"M3 P1-P4 完成（含超限恢复）"，`docs/memory/project.md` 写"超限恢复插队完成（L2/L3/L4）"——但 L3 的接线根本没做。下次会话读记忆会做错误假设。
- **建议修法**（agent.ts:459 catch 块改造）：
  ```ts
  } catch (err) {
    if (isContextWindowError(err)) {
      const recovered = await forceCompact(messages, {
        model: resolvedModel, system,
        summarize: async (prompt) => { /* 同 maybeCompress 内 */ },
      });
      if (recovered) {
        messages = recovered;
        stats.compressed = true;
        yield { type: 'warning', message: '上下文超限，已强制压缩后重试' };
        continue; // 重试本轮，不退 loop
      }
      // recovered === null → 熔断，落到下面 yield error
    }
    persistSession(buildSession());
    // ...原中断/error 分支
  }
  ```
- **同步需要**：补一个 `tests/agent-stream.test.ts` 用例——provider 第一次抛 `context_length_exceeded`，第二次成功 → 验证 loop 走恢复路径而非终止。这是真正的回归测试。
- **优先级**：P0（影响交付主线，且文档已声称完成）

#### 🔴-2 权限 `allow` vs `allow_always` 语义塌陷 —— 一次性许可被静默升级为永久许可

- **位置**：`src/agent.ts:379` + `src/ui/use-agent-stream.ts:133-140` + `src/ui/permission-dialog.tsx:9-16`
- **问题**：
  - UI 三选项语义清晰：`allow`（Yes，一次性）、`allow_always`（Yes，本会话不再问）、`deny`。
  - `use-agent-stream.ts:133-136` 谨慎区分：仅在 `allow_always` 时 `allowRef.current.add(toolName)`。
  - 但 `agent.ts:379` 在 gate 返回 `'allow'` 后**无条件执行** `allow.add(tc.name);`，注释写"会话记住，后续同工具不再询问"——这是 `allow_always` 的语义，不是 `allow`。
  - 后果：用户第一次选 `allow`（一次性），后续所有同工具调用都被 `shouldAsk` 判 false 直接放行。PermissionDialog 的三选项宣传与实际行为不符，**安全语义被破坏**。
- **根因**：`PermissionGate.ask` 的返回类型是 `Promise<'allow' | 'deny'>`（`permission.ts:35`），UI 的 `allow_always` 在 `use-agent-stream.ts:137` 被压平为 `'allow'` 传给 agent。agent 无法区分两种语义，干脆一律当作 `allow_always`。
- **建议修法**：
  1. `permission.ts` 改 `ask(): Promise<'allow' | 'allow_always' | 'deny'>`
  2. `use-agent-stream.ts:137` 直接透传 decision（不再压平）
  3. `agent.ts:379` 改为 `if (decision === 'allow_always') allow.add(tc.name);`
  4. 补 `tests/agent-stream.test.ts` 用例：返回 `'allow'` → 第二次同工具仍触发 `permission_request`
- **优先级**：P0（权限系统正确性，M4 权限里程碑的前置基础）

#### 🔴-3 StatusBar 的 `Ctx%` 用累计 token 计算，多轮对话后持续虚高

- **位置**：`src/ui/app.tsx:275` + `src/ui/reduce-agent-event.ts:122-129`
- **问题**：
  - `app.tsx:275`：`ctxPercent={Math.min(99, Math.round((api.usage.inputTokens / contextWindow) * 100))}`
  - `reduceAgentEvent.ts:122-129`：`usage.inputTokens` 是**跨轮累加**（`state.usage.inputTokens + event.inputTokens`），不是当前轮的 prompt 大小。
  - 后果：跑 10 轮后，假设每轮 prompt 5K token，UI 显示的 `Ctx%` 基于累计 50K 算，而真实 prompt 可能只有 8K（含历史）。用户看到 `Ctx 50%` 误以为快超限，实际还有大量空间。**核心观测指标失真**。
  - GLM-5.2 窗口 1M，累计到 50% 显示需要 50 万累计 token，问题被大窗口掩盖；切到 deepseek-chat（128K）会快速暴露。
- **建议修法**：
  - `StreamState.usage` 区分 `cumulativeInput`（累计，用于 $cost）和 `lastPromptTokens`（最近一轮，用于 Ctx%）。
  - `reduceAgentEvent` 在 `usage` 事件里同时更新两份。
  - `StatusBar.estimateCost` 继续用累计；`ctxPercent` 改用 `lastPromptTokens`。
- **优先级**：P0（核心 UI 指标，影响用户对上下文的判断）

---

### 🟡 中严重度

#### 🟡-1 `/compact` 和 `/model` 命令仅占位未实现

- **位置**：`src/ui/app.tsx:207-214` + `src/slash-commands.ts:14-23`
- **问题**：`SLASH_COMMANDS` 注册了 8 个命令，`app.tsx` 只实现 6 个；`/compact` 和 `/model` 走 `default` 分支输出"尚未实现"。`/compact` 尤其重要——它是用户手动触发上下文压缩的入口，与 🔴-1 叠加构成上下文管理短板。
- **建议**：至少实现 `/compact`（调 `forceCompact` 或 `maybeCompress` 强制版），`/model` 可推迟到 M4。或者在欢迎屏明确标注"尚未实现"，避免用户期望落差。

#### 🟡-2 `logApiResponse` 写死 0/0 token，违背"关键路径必须有日志"原则

- **位置**：`src/agent.ts:303-309`
- **问题**：
  ```ts
  logApiResponse(
    iteration,
    assistantBlocks,
    { unified: toolCalls.length > 0 ? 'tool-use' : 'stop' },
    { inputTokens: 0, outputTokens: 0 }, // ← 写死
  );
  ```
  注释解释"流式下 usage 可能不完整"，但此时 `consumed.usage` 已从 stream 末尾的 `usage` 事件提取（OpenAI 已开 `stream_options.include_usage`，Anthropic 在 `message_delta`），大多数情况是完整值。runtime-log 是 `docs/memory/debugging.md #008` 明文规定的"排障生命线"，写死 0 让 token 相关排障变盲区。
- **建议**：直接传 `consumed.usage`，未完整时由 log 端兜底显示 `?`。

#### 🟡-3 `/clear` 不重置 error/usage/streamingText/lastCompleted

- **位置**：`src/ui/use-agent-stream.ts:148-153`
- **问题**：
  ```ts
  setState((prev) => ({
    ...prev,
    completedMessages: [],
    pendingReadSearch: [],
    staticKey: prev.staticKey + 1,
  }));
  ```
  `error`、`usage`、`streamingText`、`lastCompleted`、`currentModel` 等都保留。`/clear` 的语义是"开新会话"，残留旧 token 数（与 🔴-3 叠加更严重）、旧 error 文本会让用户困惑。
- **建议**：要么显式重置全部业务字段，要么 `setState(initialStreamState)` 配合 `staticKey++` 保留键。

#### 🟡-4 `docs/memory/project.md` 多处过时，新会话读它会做错误假设

- **位置**：`docs/memory/project.md:17-31, 99-103`
- **问题**：
  - "架构骨架"写 `src/tools.ts`（实际已重构为 `src/tools/` 目录，registry/executor 分离）。
  - "环境"写"默认走 DeepSeek 兼容端点"和 `ANTHROPIC_AUTH_TOKEN`，但 `providers/config.ts:30` `defaultModel: 'glm-5.2'`、`apiKeyEnv: 'ZHIPUAI_API_KEY'`。M2 已切到 config.json + GLM 默认。
  - "里程碑"写"M3 P1-P4 完成（含超限恢复）"，但见 🔴-1，L3 实为死代码。
- **建议**：每次大里程碑收尾时同步刷 `project.md`（呼应 CLAUDE.md §1.6「设计文档更新时同步改引用"）。

#### 🟡-5 同步 IO 阻塞 agent loop

- **位置**：`src/tools/bash.ts:7`（`execSync`，30s 阻塞）+ `src/tools/grep.ts:69-84`（同步 `readdirSync`+`readFileSync` 递归）+ `src/tools/edit-file.ts` / `read-file.ts`（同步 fs）
- **问题**：agent loop 是 async generator，但工具用 sync fs/exec。`bash` 跑长命令时，整个 loop 阻塞——流式输出中断（用户感知卡顿）、中断信号（Esc/Ctrl+C）要等命令结束才能处理。
- **建议**：M3.5 之后逐步把 `execSync` → `spawn` 异步化、`readdirSync` → `fs.promises.opendir`。优先级取决于真实痛点（grep 在大仓慢、bash 长命令是高频痛点）。

#### 🟡-6 token 计数 O(N²)

- **位置**：`src/agent.ts:255`（每轮调 `maybeCompress` → `isOverThreshold` → `countTokens` 遍历全部 messages）+ `src/token-counter.ts`
- **问题**：N 轮后总成本 O(N²)。REPL 多轮场景（M3.5）会逐渐变慢。GLM 1M 窗口能撑很久才压缩，问题被掩盖。
- **建议**：增量计数（cache 上次算到的位置 + delta），或每 N 轮才精确算一次。

#### 🟡-7 `consumeStream` 的 `let consumed!: ConsumedStream` 用了 non-null assertion

- **位置**：`src/agent.ts:285`
- **问题**：
  ```ts
  let consumed!: ConsumedStream; // drain 必在 done=true 时 break，break 前已赋值
  ```
  注释解释了不变量，但 `!` 是"我知道更好"的逃生口。drain 循环复杂度上升后（比如未来加 early return），不变量可能悄悄破坏，TS 不会提示。
- **建议**：改 `let consumed: ConsumedStream | undefined`，循环后 `if (!consumed) throw new Error('内部错误：stream 未完成即结束')`。失败可观测、可防御。

#### 🟡-8 未实现的 `/write_file` 工具被 `tool-panel.tsx` 引用

- **位置**：`src/ui/tool-panel.tsx:42, 58-63, 203-204`
- **问题**：`foldContent` / `summarizeArg` 处理了 `write_file` 工具的折叠策略（前 10 行），但 `tools/registry.ts` 只注册了 `read_file/bash/edit_file/grep/glob` 五个工具，没有 `write_file`。死分支。
- **建议**：要么补 `write_file` 工具（与 `edit_file` 高度重合，YAGNI），要么删 `tool-panel.tsx` 里的 `write_file` 分支。

---

### 🟢 低严重度

#### 🟢-1 `session.ts` 写盘二次重试失败时异常逃逸

- **位置**：`src/session.ts:140-145`
- **问题**：`try { writeAtomically(); } catch { writeAtomically(); }` —— 第二次失败异常向上抛。被 `agent.ts:persistSession` 的 try/catch 兜住，但 `saveSession` 的契约（"调用方放心调，失败抛清晰错"）和实际行为有 gap。
- **建议**：注释明示"二次重试失败会抛，调用方需 try/catch"，或统一进 try。

#### 🟢-2 `grep.ts` 用 `forEach + return` 做上限控制，功能正确但低效

- **位置**：`src/tools/grep.ts:44-49`
- **问题**：`forEach` 回调里的 `return` 只退出当前迭代（等价 `continue`），不会 break。命中 `MAX_MATCH_COUNT=500` 后仍遍历剩余行。文件大时不必要的 IO。
- **建议**：换 `for-of + break`，或保持现状但在外层 walk 也加 early exit。

#### 🟢-3 注释引用另一个项目的具体行号会失效

- **位置**：`src/providers/config.ts:32`（`对齐 CCode 源码 config-manager.ts:53`）等多处
- **问题**：跨项目行号引用维护成本高，CCode 改一行 ECode 注释就过时。
- **建议**：改成"对齐 CCode config-manager.ts 的 GLM 默认端点（含 /coding/）"——描述性而非行号。

#### 🟢-4 `truncate.ts` 用 `string.length`，CJK 字符显示宽度不准

- **位置**：`src/tools/truncate.ts:7-10`
- **问题**：CJK 字符 `length=1` 但占 2 终端列。截断 30000 字符实际显示宽度可能 60000。`ui/display-width.ts` 已实现正确的 East Asian Width，但工具层未用。
- **影响**：仅影响回喂给 LLM 的工具结果（LLM 不在乎显示宽度），UI 渲染层不调用 truncate，所以实际影响小。

#### 🟢-5 `index.ts` 注册 SIGINT 监听但无卸载

- **位置**：`src/index.ts:213-215, 274-276`
- **问题**：`process.on('SIGINT', ...)` 注册后不 off。CLI 一次性进程问题不大，但与 React render() 长期共存时若改架构会累积。
- **建议**：保持现状（CLI 进程级），但加注释说明"process-level 一次性注册"。

#### 🟢-6 `docs/项目使用指南.md` 未在 `MEMORY.md` 索引登记

- **位置**：`docs/memory/MEMORY.md` + `docs/项目使用指南.md`（新增未跟踪文件）
- **问题**：CLAUDE.md §8.6 要求"新建文件后在 MEMORY.md 索引登记"。该指南未登记。
- **建议**：要么登记进索引，要么作为里程碑文档并入主三文档。

#### 🟢-7 `runtime-logger.ts` 用 `__dirname`（CJS 残留）定位日志根

- **位置**：`src/runtime-logger.ts:20`
- **问题**：`const __dirname = dirname(fileURLToPath(import.meta.url));` 在 ESM 下手动造 `__dirname`，把日志根硬绑到源码目录的 `docs/logs/runtime/`。dev（src/）和 prod（dist/）会指向不同位置，跨模式排查容易混乱。
- **建议**：日志根用 `process.cwd()` 为基准（用户视角的"项目根"），与 session 落盘 `.ecode/sessions/` 一致。

---

## 三、各维度小结

### 3.1 架构 ✅ 优秀

分层清晰，关注点分离到位。Provider 抽象（M2）让 agent loop 完全解耦 SDK；UI 层通过事件流 + 纯函数 reducer 与 core 解耦；session.ts 纯数据层零 LLM 依赖。`tools/registry.ts` 声明式工具 + executor 纯 find+execute（无 switch）扩展性好。唯一架构短板是 🔴-1：L3 恢复机制设计到位但未接线，相当于"有零件没装上"。

### 3.2 代码质量 ✅ 良好

- **命名**：业务语义清晰（`taskToSlug` / `flushReadSearch` / `consumeStream`），无意义缩写少见。
- **防御式编程**：大部分函数用卫语句早返回（`if (!apiKey) throw ...`）；`safeParseToolInput` / `safeParseJSON` 容错解析；assert-never exhaustive check 到处用。
- **注释**：解释 Why 而非 What，agent.ts 顶部有 loop 原理图，复杂处（如 `consumeStream` 设计、`staticKey` 机制）都有决策注释。
- **异常处理**：无空 catch（只有极少数 `catch {}` 配 `// ignore` 注释，如 session.ts:131 的 unlink）；异常信息大多含上下文。
- **魔法值**：基本都提为常量（`MAX_ITERATIONS=25` / `GRACE_MS=425` / `WRITE_HEAD=10`）。
- **短板**：见 🟡-7（`!` non-null assertion）和 🟡-2（runtime-log 写死 0）。

### 3.3 红线遵守 ✅ 良好

- **ESM `.js` 后缀**：`grep -rn "from '\.\./" src/ | grep -v "\.js'"` 输出为空，全部相对 import 带 `.js`。
- **tsconfig strict + noUnusedLocals/Parameters**：`npx tsc --noEmit` clean。
- **tool_result 配对**：`agent.ts` 在 deny 分支也坚持 push tool_result（line 367-376），配对不断裂；`context-manager.ts` 有 `verifyPairing` 最后防线；`pairing.test.ts` 单测覆盖。
- **密钥脱敏**：`.gitignore` 覆盖 `.env` / `.env.*` / `.ecode/` / `*.session.json` / `.claude/`；`config.ts` 用 `apiKeyEnv` 字段（指向环境变量名），不在 config.json 存 key；`factory.ts` 从 `process.env` 取 key。
- **session 文件**：纯业务数据（messages/stats），无密钥；落盘 `.ecode/sessions/`（gitignore）。

### 3.4 测试覆盖 ✅ 优秀，但有盲区

- **覆盖良好**：agent loop（事件序列/续接/中断/R4 流式/压缩触发）、context-manager（trim/级联/forceCompact/降级）、session 往返/碰撞/原子写、provider 翻译、reducer 全分支、REPL 人肉驱动（斜杠命令/picker/会话切换/Ctrl+O）。
- **防假绿意识强**：`preferences.md` 5 条约定，`repl-human.test.tsx` 注释里写 mutation checklist，每个用例都问"破坏对应代码能变红吗"。
- **盲区**：
  - 🔴-1 的 forceCompact 接线没有集成测试（纯函数测了，端到端没测）。
  - 🔴-2 的 allow vs allow_always 区分没有 agent loop 级测试。
  - 配对完整性的端到端测试缺失（pairing.test.ts 只测纯函数，没测 agent loop 跑过多轮工具后 messages 是否真的配对）。

### 3.5 安全 ✅ 良好

密钥走环境变量，config.json 只存 env 名；`.gitignore` 完整覆盖敏感产物；session 文件不含密钥；permission 系统设计合理（但见 🔴-2 语义塌陷）；`bash` 标 `dangerous: true` 触发审批。**注意**：当前权限默认放行 dangerous（无 gate 时，agent.ts:381），这是 CLI 模式故意为之，但要在 M4 权限里程碑明文收紧。

### 3.6 技术债 / TODO 🟡 中等

- **未实现**：`/compact` `model` 命令（🟡-1）；`write_file` 工具（🟡-8 死分支）。
- **推迟项**（`project.md` 标注）：P5 并行只读工具 / retry 读 Retry-After / usage 细化；Ctrl+O B+ 待真机确认；A 文本重复 / B 乱码另立项。
- **文档/记忆失真**：见 🔴-1 和 🟡-4——这是比代码 TODO 更危险的债，因为它会让下一次开发基于错误前提。

### 3.7 风险点

- **性能**：🟡-5 同步 IO 阻塞（bash/grep 在长任务时全 loop 卡住）、🟡-6 token 计数 O(N²)（长会话渐慢）。
- **跨平台**：`docs/memory/debugging.md #006` GLM coding 端点已记录；`session.ts` 的 slug 处理了 `[\\/:*?"<>|]`；`grep.ts:12` IGNORE_DIRS 含 `.next`/`coverage` 等多场景；`bash.ts` 在 Windows 上跑 sh 命令会失败（依赖用户 git bash）。
- **进程/终端**：`index.ts:213-215` SIGINT 注册 fire-and-forget（呼应 CLAUDE.md §9.4）；`app.tsx` 的双击 Ctrl+C 2000ms 窗口语义清晰。
- **并发**：`AllowList` 非线程安全（但单进程 React，OK）；`session.ts` 原子写防并行写同文件（已实现 tmp+rename）。

### 3.8 一致性 🟡 中

- **代码 ↔ 文档**：见 🟡-4（project.md 过时）、🔴-1（debugging.md 声称已实现实为死代码）。
- **命名**：tools/registry.ts 注释还提到"switch/case"的对照（line 9），但已无 switch；tool-panel.tsx 引用了不存在的 write_file（🟡-8）。
- **风格**：T {color tokens} / SYMBOLS 集中管理；左边框 `leftBorder` 共享；UI 层样式高度一致。

---

## 四、Top 优先级修复清单

### P0（影响功能正确性，必须立刻修）

| # | 问题 | 文件 | 工作量 |
|---|---|---|---|
| 1 | 接入 `forceCompact`/`isContextWindowError` 到 agent.ts catch 块（🔴-1） | `src/agent.ts:459` | 2h（含测试） |
| 2 | 修权限 allow vs allow_always 语义塌陷（🔴-2） | `src/permission.ts` + `src/agent.ts:379` + `src/ui/use-agent-stream.ts:137` | 1.5h |
| 3 | StatusBar Ctx% 用累计 token → 改用本轮 prompt（🔴-3） | `src/ui/types.ts` + `src/ui/reduce-agent-event.ts:122` + `src/ui/app.tsx:275` | 1h |
| 4 | 修正 `docs/memory/project.md` 过时内容（🟡-4）+ 修正 `debugging.md #005` 措辞（🔴-1 关联） | `docs/memory/project.md` + `docs/memory/debugging.md` | 30min |

### P1（影响可交付体验，本里程碑修）

| # | 问题 | 文件 |
|---|---|---|
| 5 | 实现 `/compact` 命令（🟡-1），`/model` 可推迟 | `src/ui/app.tsx:207` |
| 6 | `logApiResponse` 传真实 usage（🟡-2） | `src/agent.ts:303` |
| 7 | `/clear` 完整重置 state（🟡-3） | `src/ui/use-agent-stream.ts:148` |
| 8 | 删 `tool-panel.tsx` 的 `write_file` 死分支（🟡-8）或补工具 | `src/ui/tool-panel.tsx` |

### P2（打磨项，下里程碑）

| # | 问题 | 文件 |
|---|---|---|
| 9 | 工具 fs/exec 异步化（🟡-5） | `src/tools/bash.ts` + `src/tools/grep.ts` |
| 10 | token 计数增量缓存（🟡-6） | `src/token-counter.ts` |
| 11 | 注释跨项目行号清理（🟢-3） | `src/providers/config.ts` 等 |
| 12 | runtime-logger 日志根改 process.cwd()（🟢-7） | `src/runtime-logger.ts:20` |

---

## 五、总体评价

### 5.1 优势

1. **架构清晰、关注点分离到位**——Provider/UI/Core/Tools 四层解耦干净，agent loop 不绑 SDK、UI 不绑 core、session 纯数据层。换模型换 UI 都不需要动核心。
2. **测试覆盖广且哲学成熟**——400 测试覆盖核心路径；"防假绿 5 条"和 mutation checklist 显示团队对"测试诚实"的自觉；reducer/纯函数大量抽离便于单测。
3. **工程纪律严**——tsc strict + ESM `.js` 全合规；tool_use/tool_result 配对有多层防线（agent 推 + verifyPairing 兜底）；权限/密钥走环境变量；session 原子写 + UUID 防碰撞。
4. **文档/记忆系统完善**——CLAUDE.md 九节红线 + `docs/memory/` 五分类 + 里程碑三文档规范，跨设备同步设计周到；踩坑记录详细到可复用。
5. **细节打磨**——`<Static>` append-only 坑（debugging.md #009）、GLM coding 端点（#006）、Session ID UUID（#007）都已踩过并记录。

### 5.2 主要风险

1. **🔴 L3 响应式恢复是死代码（#005 排查结论"已实现"实为未接线）**——这是最危险的一类问题：测试全绿、记忆声称完成、实际生产环境一遇到 context-window 400 就死。原因可能是 P3 阶段先写纯函数再计划接线，但接线步骤漏了，文档却没同步修正。**必须立即接入或修正记忆措辞。**
2. **🔴 权限系统语义塌陷**——M4 权限里程碑的前置基础有问题。若 M4 基于现有 `PermissionGate` 接口扩展，allow/always 的混淆会被放大。建议 M4 启动前先修 🔴-2。
3. **核心观测指标失真**——Ctx% 是用户判断"还能聊多久"的关键指标，累计 token 算法让它在多轮后完全失真。
4. **文档与代码 drift**——`project.md` 三处过时（架构/环境/里程碑状态），新会话/新贡献者读它会做错误假设。这是开源项目的隐形税。
5. **同步 IO 阻塞**——长 bash 命令、大仓 grep 时全 loop 卡住，REPL 体验退化。M3.5 沉浸式入口尤其受影响。

### 5.3 一句话结论

**架构和工程纪律达到开源产品水准**，但有一处"声称完成实为死代码"的功能（L3 恢复）和一处"安全语义被静默破坏"的 bug（allow/always）必须在交付前处理。其余多为打磨项，不构成阻塞。
