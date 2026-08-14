---
id: ADR-026
title: 引入 AppContext 与 Plugin 装配骨架（借鉴 deepseek-harness）
status: proposed
date: 2026-08-14
supersedes: []
related_analysis: []
---

# ADR-026: 引入 AppContext 与 Plugin 装配骨架（借鉴 deepseek-harness）

## 背景 (Context)

ECode 当前的能力装配集中在 `cli/index.ts` 的 `makeDeps()`：手写 `new` + `register()` 把全部内置 tool / provider / command 装进两个 Registry 与 `Deps`，再传给心脏（`runLoop`）和 TUI（`TuiApp`）。这套"中心化硬编码装配"在 MVP 阶段足够简单，但两个即将到来的里程碑会把它撑爆：

- **M5 上下文压缩**（`详设/2026-08-14_后续-M5实施方案_已完成.md`）要引入 `CompactionOrchestrator` + `CompactionStrategy` registry，其 P9 明确写"cli makeDeps 注入编排器（注册 summarize 策略 + lastUsage 闭包）"。
- **M6 能力扩展面**（`详设/2026-08-14_后续-M6实施方案_待审核.md`）要引入 Skill / MCP / Plugin 三个子系统。其中 Plugin 系统（P1-P7）的 `PluginLoader` 在启动期把外部第三方插件"分发到各 Registry"。

问题在于：`makeDeps` 是唯一的装配点，每加一个子系统就要回来改它；各 Registry（`ToolRegistry` / `LLMProviderRegistry` / `CommandRegistry`，未来 + 压缩策略 registry / SkillRegistry / MCP registry）散落在不同模块，没有统一的装配契约；M6 的 `PluginLoader` 要硬编码知道每个 Registry 的引用才能分发。

ECode 其实已有插件化的雏形——两个 Registry 就是"可插拔分支面"（AGENTS 2.6："加工具/模型 = 写实现 + `register()`，心脏零改动"），缺的只是**把分散的 register 调用收敛成统一装配骨架**。

本 ADR 基于 deepseek-harness 源码调研（`D:\study\deepseek-harness`：`vendor/cordis/src/registry.ts` 的 Plugin 形状、`docs/architecture.md` 的 capability seam、`docs/cookbook/adding-a-package.md` 的装配流程）。

## 决策 (Decision)

引入三层轻量骨架，把内置 tools / providers / commands（及未来的 M5 编排器、M6 `PluginLoader`）统一为"挂进 ctx 的 plugin"，替代 `makeDeps` 硬编码装配：

1. **`AppContext`**——集中容器，把现有 `Deps` 的字段 + `commands` + `cwd/signal` 收成一处（对应 deepseek-harness 的 `ctx`）。
2. **`Plugin` 契约**——`{ name, inject?, apply(ctx): Disposer | void }`（对应 Cordis plugin 形状，但去掉 fiber / isolate / reflect）。
3. **声明式插件清单 `plugins.ts` + `PluginHost`**——按清单顺序 `apply`，收集 disposer，支持卸载与测试隔离（对应 harness 的 "registrations are effects"，但不引运行时）。

**只借思想骨架，不引运行时**：不引入 Cordis 的 fiber / isolate realm / reflect / `cordis.yml` patch 层 / HMR——那是一个十万行的产品级框架，对 ECode（当前约 3600 行）严重违背 KISS & YAGNI。零新依赖，纯 TypeScript 新增一个 `src/app/` 目录。

## 层次划界（与 M5 / M6 不冲突，而是叠加）

这是本 ADR 最容易被误读的点，先行澄清——三层 plugin 概念正交，互不取代：

| 层 | 归属 | 是什么 | 本 ADR 关系 |
|---|---|---|---|
| **装配骨架** | 本 ADR（ADR-026） | `AppContext` + `Plugin` 契约 + 清单：统一**所有**能力的挂载方式 | 本身 |
| 领域策略 registry | M5 | `CompactionStrategy` registry + 编排器：压缩**策略**可插拔 | `ctx.compaction` 是 AppContext 一个字段；summarize 策略是一个 internal plugin |
| 用户态外部插件 | M6 P1-P7 | marketplace + cache + 清单：加载**第三方**插件包 | `PluginLoader` 本身是一个 internal plugin；它加载的外部插件经 `ctx.tools.register` / `ctx.commands.register` 注入，和内置走同一装配机制 |

一句话：本 ADR 是**最底层装配底座**；M5 的领域 registry、M6 的用户态加载器都在其上构建。M6 方案 P1 已声明"Plugin 是资源容器，本身不执行……loader 扫描后分发到各 Registry，不引入新执行机制"——本 ADR 恰好为那个"分发"提供统一落点（`ctx.<registry>.register`），让 `PluginLoader` 不必硬编码每个 Registry 引用。

## 理由 (Rationale)

1. **契合既有，零破坏**：`ToolRegistry` / `LLMProviderRegistry` / `CommandRegistry` 的接口（`register` / `get` / `specs` / `validate`）完全不动，心脏 `runLoop` 仍从入参取用。本 ADR 只把 `makeDeps` 里的 `new + register` 搬进各 `plugin.apply`，现有 409 个单测不受影响。

2. **为 M5 / M6 铺底座，省重构债**：有了骨架后，M5 编排器 = `apply(ctx){ ctx.compaction = new Orchestrator(...); ctx.compaction.register(summarizeStrategy) }`；M6 `PluginLoader` = 一个 internal plugin，外部插件经 `ctx.tools/ctx.commands` 注入。两个里程碑都变成"加一个 plugin"，不再各自回头改 `makeDeps`。若等 M5/M6 落地后再统一装配，是两次硬编码 → 一次重构的返工。

3. **分离装配机制与装配内容**：`AppContext` / `Plugin` / `PluginHost` 是机制（写一次稳定），`plugins.ts` 清单是内容（声明式扩展）。`makeDeps` 把两者揉在一起，导致每加能力都要改机制文件。

4. **统一三角色命名**：用 deepseek-harness 的 capability seam 词汇命名 ECode 已有结构——`ToolRegistry` / `LLMProviderRegistry` / `CommandRegistry` = **Service Definition**；各 tool / provider / command = **Provider**；`runLoop` / `TuiApp` = **Consumer**。降低后续维护认知负担。

5. **零新依赖、KISS**：纯 TS 新增 `src/app/`（估算 < 150 行），不引 YAML / reflect / fiber。契合 AGENTS 1.1 极简导向。

6. **支持卸载与测试隔离**：`register` / `apply` 返回 disposer，`PluginHost.dispose()` 逆序回收。当前测试靠重建 Registry 隔离，有了 disposer 可在同一进程内挂载/卸载，为未来热重载留路。

## 接口签名示意（决策依据，非实现承诺）

```ts
// src/app/context.ts —— 集中容器（Deps 的超集）
export interface AppContext {
  readonly config: Config
  readonly logger: Logger
  readonly tools: ToolRegistry
  readonly providers: LLMProviderRegistry
  readonly commands: CommandRegistry
  cwd: string
  signal: AbortSignal
}

// src/app/plugin.ts —— 契约（借鉴 Cordis plugin 形状，去运行时）
export type Disposer = () => void
export interface Plugin {
  name: string
  inject?: readonly (keyof AppContext)[]
  apply(ctx: AppContext): Disposer | void
}

// src/app/plugins.ts —— 声明式清单（替代 makeDeps 硬编码；不引 YAML）
export const plugins: readonly Plugin[] = [anthropicPlugin, openaiPlugin, readFilePlugin, /* ... */ builtinCommandsPlugin]
```

工具改造极轻（以 `read_file` 为例，实现定义不变，末尾加导出）：

```ts
export const readFilePlugin: Plugin = { name: 'read-file', apply(ctx) { ctx.tools.register(readFileTool) } }
```

## 后果 (Consequences)

**正面**

- 加任何新能力 = 写一个 `Plugin` + `plugins.ts` 加一行；`makeDeps` 不再膨胀。
- M5 / M6 落地时直接用骨架，零额外装配设计；M6 外部插件与内置走同一装配路径。
- disposer 支持卸载与测试隔离，为热重载留路。
- 统一三角色词汇，文档与代码一致。

**负面 / 代价（必须写明）**

- **多一层抽象**：对当前 3600 行项目，`AppContext` / `Plugin` / `PluginHost` 看似"过度"。判断依据：它不是为现在，而是 M5/M6 的底座；骨架极轻（< 150 行），即便 M5/M6 最终不采用，也立即解决 `makeDeps` 膨胀。
- **`plugins.ts` 与 `makeDeps` 本质都"列举"**：短期看没省代码——但分离了机制与内容，内容可声明式扩展、可被 `PluginLoader` 复用。
- **`Deps` → `AppContext` 迁移面**：`TuiApp` / `runLoop` 的入参要从 `Deps` 改为 `ctx`（或由 `ctx` 派生）。`Deps` 结构是 `AppContext` 子集，迁移机械可控。
- **风险**：若 M5 / M6 最终不按本骨架做，`AppContext` 可能沦为过度设计。缓解：骨架极轻且立即见效，沉没成本可忽略。

## 备选 (Alternatives considered)

1. **直接引入 Cordis（vendored 或 npm `@deepseek-ai/cordis`）**：能力最强（fiber / isolate / reflect / `cordis.yml` 组合 / HMR 全有）。否决：对 ECode 严重过度工程化，违背 KISS，且引入大依赖与 Cordis 的类型面耦合。本 ADR 只借思想骨架。

2. **不动，继续 `makeDeps` 硬编码**：零改动。否决：M5/M6 每个子系统各自设计装配，`makeDeps` 持续膨胀，M6 `PluginLoader` 硬编码 Registry 引用。短期省、长期债。

3. **只做"装配函数模块化"**（把 `makeDeps` 拆成几个 `register*` 函数，不引 `AppContext` / `Plugin` 契约）：比现状略好。否决：没有统一契约，M6 `PluginLoader` 仍硬编码 Registry，各子系统装配方式不统一。不如直接做本 ADR 的轻量骨架，成本相近、收益更大。

4. **反向接入：用 harness 的 ACP / SDK 把后端换成 deepseek-harness**（即用户最初提的"嵌入后端"方向）：跨进程、丢弃 ECode 自己的心脏与工具层，与"架构借鉴"方向相反。否决（属于另一条路，见与本 ADR 并行的方向讨论）。

## 落地阶段（供评审通过后执行）

| 阶段 | 内容 | 验证 |
|---|---|---|
| **阶段 1** | 新建 `src/app/`（`context.ts` / `plugin.ts` / `host.ts` / `plugins.ts`）+ 改造 `cli/index.ts` 装配点 + 迁移 7 工具 / 2 provider / 内置命令为 plugin + 补 `tests/app/` | 现有 409 测试全绿；新增 PluginHost 装配 / disposer 单测 |
| **阶段 2** | 三角色命名写进受影响 README / 详设章节 | 文档与代码一致 |
| **阶段 3（可选）** | loop 的 `LoopCallbacks` 演化为 `ctx.on/emit` 事件总线，为 M5/M6 的事件钩子铺路 | YAGNI，M5/M6 真正需要事件钩子时再做 |

## 开放问题

- M5 的 `ctx.compaction` 字段命名与编排器构造时机（启动期构造 vs 懒加载）待 M5 实施时与本骨架协同定。
- M6 `PluginLoader` 作为 internal plugin 时，外部插件的 `register` 是否需要命名空间隔离（如 `mcp__server__tool`）——M6 方案已部分涉及，待 M6 实施时定。
- `AppContext` 是否预留 `extras: Record<string, unknown>` 动态槽位供未来 skill/mcp registry：YAGNI，先不加，需要时再扩。

## 后续评估（2026-08-14，M5 完成后）——暂缓采纳

**结论：暂缓。M6 实施到装配环节（PluginLoader）时验证真实需求，若确需统一骨架，开新 ADR supersedes 本篇。**

评估依据：

1. **核心论据"makeDeps 会撑爆"未成立**：M5 已按 makeDeps 硬编码落地（编排器 3 行 + lastUsage 1 行），makeDeps 共 22 行，健康。本 ADR 写作于 M5 实施前，预判的场景没有发生。
2. **"省两次重构"论据失效一半**：M5 已硬编码，现在采纳反而多一次"回头迁移 M5 装配"的工。
3. **成本是真实的，收益是假设的**：迁移面不止 150 行骨架——`Deps → AppContext` 要动 `TuiApp` / `runLoop` 入参 + 一整批构造 deps 的测试，冒回归风险换假设收益，不划算。
4. **M6 用不用得上是未知数**：M6 顺序 Skill → MCP → Plugin，Plugin 排最末；真到 PluginLoader 那天，可能"拿几个 registry 引用分发"的 20 行就够，不需要正式骨架。
5. 契合 AGENTS 1.1"如无必要勿增实体"——为不存在的问题加抽象层是 YAGNI 反面。

**验证过的部分依然有效**（供未来采纳时参考）：deepseek-harness 三处源码引用准确（Cordis Plugin 形状 / capability seam 三角色 / ctx 统一落点），"只借骨架不引运行时"的裁剪正确。若 M6 后确需骨架，本篇的设计（AppContext / Plugin 契约 / plugins.ts 清单 / disposer）可直接作为输入。
