---
layer: 解析
status: 已完成
scope: M5 关键架构修正——history/context 分离（避免恢复即压缩）+ memory/system prompt 设计
date: 2026-08-14
related:
  - 详设/2026-08-14_后续-M5实施方案_待审核.md（M5 方案，§7 history 持久化 + §1 context/history 分离 依据本文档）
  - 解析/2026-08-14_上下文压缩源码调研_已完成.md（压缩算法调研，本文档是其存储/恢复层补充）
---

# history/context 分离 + memory/system prompt 调研

> 2026-08-14。两个调研合并落档：
> 1. **history（给用户看）vs context（喂 LLM）分离**——解决用户指出的"restore 即触发压缩"设计缺陷
> 2. **memory + system prompt + 子进程 prompt 设计**——提示词怎么保存/注入

---

## 一、history vs context 分离（★ 修正 ECode 当前缺陷）

### ECode 当前缺陷（与 aider 同款，反面教材）
- `history.ts:159 restore()` 返回**全部** Message（逐行读 jsonl，只跳 meta）
- `TuiApp.tsx:209 restoreSession()` 把 restore 结果直接塞 `messagesRef.current = messages`（全量历史 = LLM context）
- **history 和 context 是同一个 messages 数组** → 长历史恢复必然立即触发压缩

### 四家对比

| 维度 | claude-code | opencode | codex | aider（反例） | ECode 当前 |
|---|---|---|---|---|---|
| 存储 | 单 jsonl append-only | SQLite append-only | rollout append-only | markdown append-only | 单 jsonl append-only |
| history(UI) vs context(LLM) | 弱分离（磁盘全量/内存=post-boundary）| **完全分离**（DB 全量/filterCompacted 投影）| 分离（rollout 全量/ContextManager 子集）| **不分离** | **不分离** |
| 压缩边界持久化 | 是（compact_boundary 行）| 是（tail_start_id 存 DB）| 是（replacement_history 快照）| **否** | **否** |
| 恢复时构建 context | 加载器 boundary 截断只读 post-boundary | 不需"恢复"，每次 prompt 现场投影 | 从最后 replacement_history 快照重建 | 全量读入内存 | **全量读入内存** |
| 恢复触发压缩？ | 不会（磁盘已是压缩态）| 不会（投影永远尊重 tail_start_id）| 不会（从快照重建）| **会** | **会** |

### ★ ECode 方案：抄 opencode（存储全量 + 运行时投影，最干净）

**核心**：history 文件全量 append-only（永不压缩，用户数据）；context 由**纯投影函数**每次请求现场算（找最后 boundary，返回 summary+recent+新消息）。restore 只切 sessionId + 刷 UI，**不往 context 灌全量**。

```
History（~/.ecode/sessions/*.jsonl）       Context（runtime，喂 provider.run）
  全量 append-only 永不压缩                  ← buildContextMessages(allMessages) 投影
  压缩时追加 boundary+summary 行              ← 找最后 boundary → [summary, ...tail, ...新消息]
  /history restore 拿全量（UI 展示）          ← 永远是 compact 子集，不会恢复即压缩
```

**实现要点**：
1. `FileHistoryStore` 保持 append-only 全量（现状不动），压缩时追加 boundary 行（含 tailStartId/summary）
2. 新增纯函数 `buildContextMessages(allMessages)`（`src/core/context.ts`，对应 opencode `filterCompacted`）：输入全量，输出 LLM context——找最后 boundary，返回 `[summary, ...从 tailStartId 的尾部, ...boundary 后新消息]`
3. `runLoop` 改造：每轮从 history 现场取 context（`buildContextMessages(history.restoreFull(sid))`），不再直接吃全量 messagesRef
4. `restoreSession` 改成只切 sessionId + 刷 UI（UI 用全量），**不往 context 灌全量**
5. UI 继续用全量渲染，boundary 处显示"已压缩"标记

**为什么不选 claude-code（方案A）/codex（方案C）**：
- 方案A（boundary 截断）：UI 也只显示 post-boundary（用户看不到被压的原文，体验差）
- 方案C（replacement_history 快照）：每次压缩存完整 context 快照，冗余大
- **方案B（opencode 投影）**：单一数据源（全量）+ 投影，UI/LLM 各取所需，最优雅

---

## 二、memory + system prompt + 子进程 prompt 设计

### 四家对比

| 维度 | claude-code | opencode | codex | aider | ECode 现状 |
|---|---|---|---|---|---|
| 指令文件 | CLAUDE.md（4层+rules/*.md）| AGENTS.md（首个匹配）| AGENTS.md（root→cwd 叠加）| CONVENTIONS.md（**不自动发现**）| AGENTS.md（**runtime 未读**）|
| 格式 | md+frontmatter(paths glob)+@include | 纯 md | 纯 md | 纯 md | md（仅开发者文档）|
| auto-memory 工具 | 有（MEMORY.md+topic 文件，模型读写）| 无 | 有（后台两阶段流水线）| 无 | 无 |
| system prompt 形态 | string[] 分段（静态前缀+动态后缀+缓存边界）| 按模型选模板+动态段 join | per-model prompt.md+personality 占位 | 硬编码类属性 | **单一静态字符串** |
| CLAUDE.md 注入位置 | **user-context 消息**（不进 system，缓存友好）| **system 数组** | **user 消息**（ContextualUser）| read-only 文件消息 | **不注入** |
| subagent | 3 种（默认/自定义/fork），fork 继承渲染字节 | agent.prompt 替代主模板 | role=TOML 配置层覆盖 | 无真 subagent（两步 coder）| 无 |

### ★ ECode 发现：AGENTS.md runtime 完全没读（最浪费现状）

ECode 的 AGENTS.md 写得极完整（6 大节通用原则 + TS/Node 规范），却没喂给 LLM。这是最低成本高收益改进。

### ECode 改进建议（按成本/收益分档）

**档1（必做，低成本）**：把 AGENTS.md 接进 runtime
- 新建 `src/services/instructions.ts`，仿 opencode `instruction.ts`（最简洁）：findUp 首个匹配 AGENTS.md（避免 claude-code 全叠加复杂度）
- `buildSystemPrompt(ctx)` 拼 AGENTS.md 进 system（ECode Provider 接口 system 是单字符串，`\n\n--- 工作区指令 ---\n\n${content}` 追加）
- 加 kill switch（env/config 禁用）

**档2（推荐，中成本）**：system prompt 分段化 + 缓存友好
- `buildSystemPrompt()` 返回 `string[]`（仿 claude-code）：静态前缀 + 动态后缀（env/workspace instructions）+ 缓存边界
- AGENTS.md 进动态段（变化不击穿静态前缀缓存）

**档3（M5+，高成本）**：auto-memory
- 最简版：`~/.ecode/memory.md` 手动维护，buildSystemPrompt 读它；`/memory` 命令打开编辑器。覆盖 80% 价值 10% 成本
- 不抄 claude-code 的模型自维护 MEMORY.md（prompt 太重 ~150 行 token）
- codex 后台流水线更工程化但实现量大

**档4（远期）**：subagent
- 抄 claude-code fork：继承父 messages 快照 + 渲染字节 + `<fork_boilerplate>` 结构化输出（Scope/Result/Key files）
- ECode AgentLoop 纯函数式，fork = 复制 messages + 起子 loop + 隔离 toolCtx，契合度高

### 通用输出规范补强（立刻可做）
ECode system prompt 只写「回复用中文」，缺关键约束（四家共识）：
```
- 工具调用前一句话说明要做什么，不用冒号结尾
- 引用代码用 file_path:line_number 格式
- 报告任务完成说清做了什么+关键发现；失败明说失败，不假装成功
```

---

## 三、对 M5 的影响（架构修正）

1. **§7 history 持久化改方案**：废弃 v4 的"history 不动"和 v3 的"boundary 写进 history restore 过滤"——改为 **opencode 投影方案**：history 全量存 + boundary 行 + 运行时 `buildContextMessages` 投影。restore 不灌全量。
2. **context/history 分离是 M5 的架构基石**（§1）：不是"压缩不影响 history"，而是"history 和 context 本就是两份东西"。
3. **memory/system prompt 不属于 M5**（属独立小改或后续）——但 AGENTS.md 接 runtime（档1）建议优先做（低成本高收益，且和压缩的 system prompt 构造有关联）。
