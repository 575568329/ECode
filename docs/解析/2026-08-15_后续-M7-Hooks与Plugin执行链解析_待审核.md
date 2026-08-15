# M7 Hooks 与 Plugin 执行链解析

> 2026-08-15 一轮连续代码走读整理成文（问答式，问题链按追问顺序展开）。回答：hook 在代码里怎么嵌入、绑定从哪注册到哪归一、触发到执行的每一跳、裁决在每个案发现场怎么消费、handler 五字段怎么被翻译成动作、plugin 四类资源装完之后靠什么触发。文末附四个高频理解误区与四个已知接线缺口。
>
> 所有锚点为 2026-08-15 时点（M7 已完成，含审阅修复批次 acdce7a 与优雅关闭 4cc1e2d）。

---

## 0. 总览：三分离模型（先看懂这张图）

ECode 的 hooks 不是"事件总线"，是一套**声明、触发、执行三处分工**的机制：

```
① 声明（存）—— 用户在三个地方写 hook，各存各的，互不相交
────────────────────────────────────────────────────────
  用户源    ~/.ecode/config.json 的 hooks 键
            └─ 启动时解析成快照（闭包变量，运行中不变）
  插件源    plugin.json + hooks/hooks.json
            └─ 安装/启用时 register 进内存注册表
  skill 源  skill 目录下的 hooks.json
            └─ skill 被触发时 register（会话级，/clear 全清）

  内存注册表 globalExtensionHooks = Map（owner → hooks）
  ★ 用户源不进注册表——两条存储永不相交，只在查询时合并

② 触发（报案）—— 分散七处，每处只喊一声"某事件发生了"
────────────────────────────────────────────────────────
  TuiApp 挂载/恢复 → SessionStart ×2
  submit 提交输入   → UserPromptSubmit（block 则本轮不进 loop）
  submit 收尾      → Stop
  工具执行前后     → Pre/PostToolUse（装饰层包裹，loop 无感知）
  退出链           → SessionEnd（优雅关闭里 await）
  （hasHandlers 守卫：没配 hook 的用户零开销跳过）

③ 归一 + 执行（办案）—— 集中一处
────────────────────────────────────────────────────────
  七个触发点全部拨给同一个方法：
    HookRunner.dispatch（runner.ts:62，唯一的汇合点）
      └─► specsFor：[...用户快照, ...扩展展平] 按 event+matcher 过滤
            └─► 逐条执行，全部交给同一个执行器：
                  runCommandHook（exec.ts:20，唯一子进程执行器）
                        └─► HookVerdict 裁决 ──► 回到案发现场消费
```

**为什么这么分**：事件本来就发生在不同代码位置（提交输入在 TuiApp、工具调用在 loop、退出在 cli），触发只能现场埋；但执行必须集中——三源的 hook 若各跑各的，聚合裁决（谁 block 了、参数被谁改了）就没有统一答案。所以设计成：**七处触发点只负责喊"某事件发生了"，全部拨给同一个 `dispatch`；三源声明在 `specsFor` 拼成一张表，同一个 for 循环逐条执行，同一个执行器 spawn**。

一句话心智模型：**七处触发点是七种门铃，铃一响拨给同一个指挥中心；指挥中心查一张合并三处的花名册，把登记了这个事件的条目派给唯一一支执行队，结果汇总成一张单子（verdict）送回按铃的现场。**

---

## 1. 注册面：三源一种结构

### 1.1 流程图

```
三个源：声明 → 解析 → 入队（行号为代码锚点）

  ① 用户源  config.json 的 hooks 键
       │ cli/index.ts:99   启动时解析一次
       ▼
     闭包变量 userHooks（快照，运行中不变）
       │ 以 getUserHooks 回调喂给 HookRunner（cli/index.ts:104）
       ▼
     specsFor 查询面（runner.ts:47）

  ② 插件源  plugin.json 的 hooks 字段 + hooks/hooks.json（两处合并）
       │ manifest.ts:199-207  discoverComponents 解析
       │ loader.ts:569        loadOne 时 register('plugin:名@市场')
       ▼
     globalExtensionHooks ──(specs() 展平，runner.ts:49)──► specsFor 查询面

  ③ skill 源  skill 目录下的 hooks.json（不是 frontmatter，独立文件）
       │ skill.ts:235-253   扫描期读好，存进 SkillInfo.hooks
       │ 触发时注册：skill.ts:50（LLM 面）/ TuiApp.tsx:820（手动面）
       ▼
     globalExtensionHooks（owner='skill:名'，会话级）

三源共用同一个校验器 parseHookSpecs（validate.ts:49，AJV）——
非法项跳过 + warn，不炸启动
```

### 1.2 详解

一条绑定 = 一个 `HookSpec`（`hooks/types.ts:35-42`）：`event`（挂哪个事件）+ `matcher`（工具事件才用）+ `handler`（执行体）+ 可选 `timeout_ms`。三个源的入队方式：

| 源 | 声明位置 | 解析代码 | 入队（存到哪） | 生命周期 |
|---|---|---|---|---|
| 用户源 | `~/.ecode/config.json` 的 `hooks` 键 | `parseUserHooks`（`validate.ts:78`，AJV） | makeDeps 闭包变量，以 `getUserHooks` 回调喂给 runner（`cli/index.ts:104`） | 启动快照，运行中不变 |
| 插件源 | 插件目录 `plugin.json` 的 hooks 字段 + `hooks/hooks.json`（合并） | `discoverComponents`（`plugin/manifest.ts:199-207`） | `globalExtensionHooks.register('plugin:名@市场')`（`loader.ts:569`） | 装/卸/启用随时增删 |
| skill 源 | skill 目录下的 `hooks.json`（**不是 frontmatter**，独立文件） | `loadSkillHooks`（`skill.ts:235-253`） | 触发时注册：LLM 面 `tools/builtin/skill.ts:50`、手动面 `TuiApp.tsx:820` | 会话级（触发即启用，`/clear` 全清） |

三个要点：

1. **校验同器**：三源都过同一个 `parseHookSpecs`（AJV + JSON Schema）——event 必须在六事件枚举内、handler 必须有非空 command。非法项**跳过 + warn，不炸启动**（与 mcpServers 同容错策略：用户手写配置不因一条写错整体罢工）。
2. **分层铁律（M7-D10）**：扩展源的 hooks **永不写入 config.json**。config 是用户领地，插件只能往内存注册表放自己的（owner 前缀标识），卸载时 `unregister(owner)` 整体拿走。注册表随时可全清重建（rebuild = clear-then-register），用户的快照谁也碰不到。
3. **存储分界**：`globalExtensionHooks` 只收扩展源（plugin + skill 两种 owner）；用户 config 的 hooks 走闭包快照独立通道。**两条存储永不相交，只在 `specsFor` 拼数组那一刻逻辑汇合**。

---

## 2. 装配面：makeDeps 只插线，不汇集

`cli/index.ts:102-105` 的构造：

```ts
const hookRunner = new HookRunner({
  extensions: globalExtensionHooks,      // 注册表对象的引用（不是内容快照）
  execute: runCommandHook,               // 执行器函数引用
  getUserHooks: () => userHooks,         // 回调（被调用才返回快照）
  getSessionId: () => sessionId,         // 回调（/clear 换 id 后能拿到新值）
  warn: (m) => logger.warn('hooks', 'exec', { message: m }),
})
```

构造函数体就一行 `this.deps = deps`（`runner.ts:32-34`）——**此刻它不知道任何一条具体的 hook**。汇集发生在每次 dispatch 里（拉模型），时序证据：

```
cli/index.ts:99    parseUserHooks → userHooks          源①解析（构造前）
cli/index.ts:102   new HookRunner({...})               插五根线；注册表此刻是空的
cli/index.ts:251   makeDeps 返回
cli/index.ts:261   loadAll → register('plugin:…')      源②这时才进注册表（构造之后）
运行中             skill 触发 → register('skill:…')     源③进注册表
每个事件           dispatch → specsFor → 现场拉两根线拼接
```

如果汇集发生在构造函数里，插件 hooks 永远不会执行——构造时 `loadAll` 还没跑。**运行时能工作这件事本身，证明汇集在 dispatch、且必须在那里。**

懒回调的两个理由：`getSessionId` 必须懒（`/clear`、恢复会话会 `setSessionId` 换 id，传值会焊死旧 id）；`getUserHooks` 与它统一成同一形态，读代码不用分两套心智。

配套的装饰层装配（`cli/index.ts:109-110`）：

```ts
let hookRunnerRef: HookRunner | null = hookRunner
const hookedTools = new HookedToolRegistry(toolReg, () => hookRunnerRef)
```

装饰层对 runner 的引用必须走 **getter**（H4 v3.1 约束）：若闭包捕获实例，hooks 原子重建后装饰层会静默执行旧集合——无报错的失效，最难排查的那种。

---

## 3. 触发面：七个案发现场 + 一种装饰器

### 3.1 全表

| # | 事件 | 触发位置 | 所在函数/时机 | 等 vs 不等 |
|---|---|---|---|---|
| ① | SessionStart(startup) | `TuiApp.tsx:553` | 挂载 useEffect | `void` 通知 |
| ② | SessionStart(resume) | `TuiApp.tsx:529` | 恢复会话（起新 sessionId 后） | `void` |
| ③ | UserPromptSubmit | `TuiApp.tsx:157` | `submit()` 内、分流后、runLoop **前** | **`await`** |
| ④ | PreToolUse | `tools/hooked.ts:61` | `wrapTool().execute` 内、真执行**前** | **`await`** |
| ⑤ | PostToolUse | `tools/hooked.ts:81` | 同一个 execute 内、真执行**后** | **`await`** |
| ⑥ | Stop | `TuiApp.tsx:308` | `submit()` 的 `finally` | `void` |
| ⑦ | SessionEnd | `cli/index.ts:195` | 优雅关闭链的 `runSessionEndHooks` | **`await`**（预算内 + failsafe 定时器） |

### 3.2 两种嵌入形态

**形态一：守卫式直调（5 处，覆盖 4 个事件）**。SessionStart/UserPromptSubmit/Stop/SessionEnd 的现场分散在 UI 生命周期和关闭流程里，没有汇聚点，只能现场插。统一纪律：

```ts
if (deps.hookRunner != null && deps.hookRunner.hasHandlers('UserPromptSubmit')) {   // ① 守卫
  const verdict = await deps.hookRunner.dispatch('UserPromptSubmit', {...})          // ② 直调
  if (verdict.block) { ...; return }        // ③ 裁决消费写在现场
  ...
}
```

- **`hasHandlers` 守卫 = 零开销跳过**（`runner.ts:40-44`）：没配 hook 的用户连 await 都不付——热路径上每次 submit 都要过这里，守卫是刻意为之。
- **裁决消费贴着事件写，不藏进框架**：UserPromptSubmit 的 block 是 `return` 不进 loop；Stop/SessionStart 的 systemMessages 在 `.then()` 里异步展示；SessionEnd 在关闭链里预算内 await。
- **`session_id: ''` 是故意的**：接线点不传，`dispatch` 里经 `getSessionId()` 统一补（`runner.ts:63-64`），七个现场免逐处取 id。
- await 与 void 的语义差：UserPromptSubmit/Pre/Post/SessionEnd 的裁决影响后续流程必须等；Stop/SessionStart 是通知不等。

**形态二：装饰器包裹（Pre/PostToolUse，loop 零感知）**。工具事件天然有汇聚点——所有工具调用（内置 + MCP 适配的 `mcp__`）都过 `ToolRegistry.get()`。`HookedToolRegistry`（`tools/hooked.ts`）代理 get() 返回包装 Tool：`execute = PreToolUse →（block 则 is_error / 改参）→ inner.execute → PostToolUse 附加 context`。**loop 里一行 hooks 代码都没有**——"心脏零改动"铁律的落地。

**为什么不是事件总线（emit/subscribe）**：① 消费是同步裁决（verdict 必须被现场 await 并影响控制流），总线是 fire-and-forget 模型，裁决没人消费等于白算；② 六事件是封闭集（`HOOK_EVENTS` const），直调 + 类型约束比引入总线基建简单，且"谁消费了裁决"一眼可见。

---

## 4. 执行链：从 dispatch 到子进程的每一跳

### 4.1 时序图（以"bash 工具被 hook 拦截"为例）

```
（以「bash 工具被 hook 拦截」为例；缩进表示调用深度，行号为代码锚点）

 用户 ── 回车 ──────────────────────────────────────► TuiApp.submit
 TuiApp ── dispatch('UserPromptSubmit')，await ────► runner
   └─ 被 block？→ 本轮直接 return，不进 loop
 TuiApp ── runLoop ─────────────────────────────────► loop（心脏开始干活）
 loop ── tools.get('bash').execute ────────────────► hooked
   ★ loop 不知道 hooks 存在——它拿到的是 HookedToolRegistry 代理
 hooked ── dispatch('PreToolUse') ─────────────────► runner
   runner ── specsFor：三源合并 + matcher 过滤（:65）
   runner ── runOne ──► runCommandHook（exec.ts）
     exec ── 黑名单检查 / 超时取小 / 平台选命令（:24-34）
     exec ── spawn（Git Bash）+ stdin 喂事件 JSON ──► hook 子进程
     hook 子进程 ── exit 0 + stdout JSON ──► exec（:70）
     exec ── stdout 白名单过滤（:97）──► runner：HookOutput
   runner ── 聚合（:78-89）──► hooked：HookVerdict
   ├─ block ──► hooked 返回 is_error tool_result ──► loop（LLM 自纠）
   └─ 放行/改参 ──► hooked 调 inner.execute（args 可能已被替换）
        hooked ── dispatch('PostToolUse') ──► runner（:81）
        runner ── additionalContext 追加进结果 ──► hooked ──► loop：ToolResult
 loop ── 一轮结束 ───────────────────────────────────► TuiApp 的 finally
 TuiApp ── dispatch('Stop')，void 不等 ─────────────► runner（:308）
```

### 4.2 specsFor：三源归一（一行拼接）

```ts
// runner.ts:47-53
specsFor(event, toolName?) {
  const user = this.deps.getUserHooks?.() ?? []   // 源①快照（?.可选调用：测试可不注入）
  const ext  = this.deps.extensions.specs()       // 源②③展平（registry.ts:45 flatMap，owner 标签丢弃）
  return [...user, ...ext].filter(
    (s) => s.event === event && matcherMatches(s.matcher, toolName),
  )
}
```

- `[...user, ...ext]` 是**扁平的 `HookSpec[]`**：拼接后分不出来源（归一的设计意图——for 循环对每条一视同仁）。
- **顺序确定且有意义**：用户源永远在前（闭包快照序），扩展源按注册序（插件 loadAll 序 → skill 触发序）。这个顺序就是执行顺序——用户 hook 先于插件 hook 生效。
- **方向是"事件找 hook"**（拉模型）：`s.event` 是这条 hook 注册时写死的愿望，`event` 是此刻正在发生的事实；filter 就是逐条问"你想要的时机是现在吗"。没有订阅回调、没有解绑动作——绑定就是数据，匹配就是一次 filter。这也是插件卸载只需 `unregister(owner)` 删 Map 一项的原因。
- `matcher` 三种写法：`"bash"`（字面量精确）| `"a|b"`（列表）| `"^mcp__fs"`（正则，可挂整个 MCP server）。空 matcher 匹配全部；非法正则回退字面量比较（一条坏正则不挂全家）。

### 4.3 runOne：fail-open 的落点

```ts
// runner.ts:95-104
private async runOne(spec, input, opts) {
  try { return await this.deps.execute(spec, input, opts) }
  catch (e) { this.deps.warn?.(`hook 执行失败（放行）：${spec.event} → ${label}：${msg}`); return null }
}
```

它是"单条执行的失败兜底包装"——真正干活的是 `deps.execute`。唯一职责：把**一切执行失败**（超时被杀、退出码非 0 非 2、黑名单拒绝、spawn 起不来、abort 中断）翻译成 `warn + null`。而 `null` 回到循环里是 `if (out === null) continue`——**一条 hook 炸了，效果等同于它不存在**：不 block、不改参、不注入，循环继续。

这就是 fail-open 铁律（H5）的代码落点：hook 是用户随手写的子进程命令，失败面大；若失败即阻断，辅助观测就成了主链路的单点故障。**block 是显式决策**（`continue:false` / exit 2），只与输出语义耦合，永不与执行成败耦合。

### 4.4 runCommandHook：子进程三通道协议

```
ECode ──stdin：事件 JSON──►  hook 子进程（你写的任意 shell）
ECode ◄──stdout：HookOutput JSON──
ECode ◄──stderr：人话 reason（exit 2 时）──
```

退出码分协议（`exec.ts:70-88`）：

| 子进程怎么做 | ECode 怎么解释 |
|---|---|
| exit 0 + stdout JSON | 按 HookOutput 解析（字段级白名单，未知字段剥离） |
| exit 0，stdout 空/非 JSON | 纯通知，什么都不改 |
| exit 2 + stderr 理由 | 轻量 block（reason 取 stderr 末行——不想拼 JSON 的快捷通道） |
| 其他码 / 超时 / 起不来 | 执行失败 → runOne catch → warn + 放行 |

### 4.5 handler 五字段 → 消费点映射

| 字段 | 唯一消费点 | 翻译成什么 |
|---|---|---|
| `kind` | `exec.ts:21` | 判别器：`≠ 'command'` throw（mcp_tool/prompt 占位未实现） |
| `command` | `exec.ts:28-37` | 黑名单检查 → `spawnShellCommand` 起子进程（Git Bash，与 bash 工具同一 spawn 基建） |
| `command_windows` | `exec.ts:25-27` | 平台选择：win32 且配置了它则替代 command |
| `timeout_ms` | `exec.ts:31-34` | `min(spec级, handler级, 60s默认)` 到点 SIGKILL |
| `async` | `runner.ts:71-74`（不在 exec！） | fire-and-forget 踢出裁决循环 |

ECode 对 command 字符串**不做任何理解**（黑名单除外）——它不是 ECode 的 API，是任意 shell。ECode 的职责是四项保障：**选对命令**（平台分流）、**给足输入**（stdin 事件 JSON——脚本靠它知道"谁、什么工具、什么参数"）、**限住边界**（超时/黑名单）、**定好对话协议**（退出码 + stdout——脚本靠它反向指挥 ECode）。

### 4.6 聚合与消费对账

多 hook 顺序执行（`runner.ts:70-89`）：block 任一成立取首个 reason；`updatedInput` 后者覆盖前者（刻意不做链式改参——多 hook 同时改参属病态配置）；additionalContext/systemMessages 全收；`async:true` 不进裁决。

**verdict 四字段对账表**（哪个现场消费哪几个字段——注意不是全消费）：

| 现场 | block | updatedInput | additionalContext | systemMessages |
|---|---|---|---|---|
| UserPromptSubmit | ✅拦截本轮 | — | ✅拼进 input | ✅底部提示 |
| PreToolUse | ✅变 is_error | ✅替换 args | ✗ 收了没人用 | ✗ 收了没人用 |
| PostToolUse | — | — | ✅追加进 tool_result | ✅同追加（[hook] 前缀） |
| Stop | — | — | ✗ 收了没人用 | ✅底部提示 |
| SessionStart ×2 | — | — | ✗ 收了没人用 | ✅底部提示 |
| SessionEnd | — | — | ✗（进程将退） | ✗ |

"收了没人用"的缺口见 §7。

---

## 5. 黑名单与占位形态

### 5.1 危险命令黑名单（`proc.ts:55-68`）

8 条正则：`rm -rf /`、`rm --no-preserve-root`、`sudo`、写裸盘 `> /dev/sdX`、fork 炸弹、`curl|sh`、`mkfs`、`dd of=/dev/disc`。命中即 throw → runOne 接住 → warn + 放行，不给重试。

它是 M3 给 bash 工具建的，hooks 直接复用（`exec.ts:28`）——理由：**第三方 hooks = 第三方命令执行**，安全底线不能比 bash 工具低。定位是"防手滑/防灾难"，不是细粒度权限系统。

### 5.2 mcp_tool / prompt：类型占位 ≠ MCP 不可用

`HookHandler` 三种设想形态（`types.ts:22-32`）：`command`（跑 shell，已实现）、`mcp_tool`（调 MCP 工具响应事件，占位）、`prompt`（问 LLM 判断，占位）。

**高频混淆**：MCP 工具本身（M6）完全可用——LLM 调 `mcp__server__tool` 走 loop→McpManager 的链路和 hooks 无关。不能用的是"**把 MCP 工具当作 hook 的响应动作**"这一种写法，且不是被禁、是没写（三家对标均无已实现先例，codex schema 标注 not supported yet——M7-D9 拍板裁剪）。三层防御防误用：AJV schema 只认 command（warning 带人话）、运行时 throw、类型系统本身。放开路径见 M9 方案附录 D（上游先例触发组）。

---

## 6. Plugin：从安装到 hooks 生效

### 6.1 关键认知先行

**插件内容不是"被插件触发"的**——插件的四类资源安装后分发进四个既有容器，各容器**原有的触发机制照常工作**：skill 走 skill 的路（LLM SkillTool / `/name` 手动面）、MCP 走 MCP 的路（LLM 调 `mcp__` 工具）、命令走命令的路（`/插件名:命令`）、hooks 走本篇 §3-4 的路。**插件只是往容器里放东西的人。**

### 6.2 安装链（含全部安全闸）

```
市场条目 source（三种来源，走不同安全闸）
  │
  ├─ github ──► git clone --depth 1
  │              ├─ 市场声明了 sha？── 是 ──► rev-parse HEAD 比对
  │              │                        不一致 = 供应链被换，安装失败
  │              └─ 通过 ──► 删掉 .git
  │
  ├─ url ──► fetch 下载 zip ──► sha256 校验 ──► 五道闸安全解压
  │          （体积/总量/单文件/条目数/压缩比——防 zip bomb 和 zip-slip）
  │
  └─ local / 市场内相对路径 ──► sanitizeRelPath 净化（防市场内路径穿越）
  │
  ▼ （三条路殊途同归）
staging 临时目录
  └─► 清单校验（缺失则合成 0.0.0 最小清单）
        └─► rename 原子落位：cache/<市场>/<插件>/<版本>/
              └─► setEnabled true（jsonc modify 写 config，保住用户注释）
                    └─► loadOne 即时接入（装完立刻能用，免重启）
```

- **目录布局**：市场 `~/.ecode/plugins/marketplaces/<名>/`；插件本体 `cache/<市场>/<插件>/<版本>/`（版本化 = 升级装新目录、旧版可回退）；启用状态是 config.json 里一行 `plugins["名@市场"]: bool`（jsonc modify 写入，保用户注释）。
- **staging + rename 原子落位**：全部先落 `.staging-*`，校验全过才 rename。中断留临时目录（finally 清），cache 永远不出现半个插件。
- **供应链校验**（审阅修复批次）：github 源 sha 比对、url 源强制 sha256、zip 解压五道闸（体积 64MB / 总量 512MB / 单文件 256MB / 条目 10 万 / 压缩比 100:1，全是对 zip bomb 和 zip-slip 的闸）、路径穿越运行时双保险 `assertInsideDir`。
- **`${ECODE_PLUGIN_ROOT}` 占位符**：插件 mcpServers 配置里的自引用路径加载时展开成 cache 绝对路径，**落盘永远是占位符**（版本升级 cache 路径会变，存展开值等于焊死在旧版本目录）。

### 6.3 资源接入与卸载（loadOne / teardown 严格镜像）

`loadOne`（`loader.ts:532-573`）四类分发：

| 组件 | 去向 | 防撞名 |
|---|---|---|
| skills/ | `SkillRegistry.addSource` | 四源优先级 project > user > **plugin** > builtin（first-wins） |
| commands/*.md | CommandRegistry `/插件名:命令` | 命名空间前缀；`$ARGUMENTS` 占位展开 |
| mcpServers | `McpManager.start` | server 名强制 `plugin:插件名/` 前缀 |
| hooks.json | `globalExtensionHooks.register('plugin:名@市场')` | owner 前缀 |

`teardown`（`loader.ts:466-501`）五步镜像：杀 MCP stdio 子进程 + removeServer → 反注册 `mcp__` 工具 → removeSource skills → 反注册命令 → unregister hooks。唯一保留 MCP metadata cache（重新启用免重连）。

---

## 7. 已知接线缺口（协议层已交付、接线层没铺完）

2026-08-15 走读发现四个，均已入 M9 方案附录 D.5（触发即待修，量级都是案发现场几行）：

| 缺口 | 锚点 |
|---|---|
| SessionStart 的 additionalContext 未消费（典型用途恰是会话注入环境信息） | `TuiApp.tsx:529/553` |
| PreToolUse verdict 的 additionalContext/systemMessages 未消费 | `hooked.ts:67-74` |
| dispatch 的 `opts.signal` 七处接线点均未传（hook 子进程不随 Ctrl+C 中断，仅超时兜底） | 全部调用形态① |
| Stop 的 stop_reason 固定 `'turn-complete'`（中断与自然结束不可区分） | `TuiApp.tsx:309` |

共同点：**协议层（types.ts + runner.ts）按全字段设计，接线层只铺了当时需要的语义**。补齐不动架构。

---

## 8. 高频理解误区速查（对话实测）

| 误区 | 正解 |
|---|---|
| "globalExtensionHooks 收所有 hooks" | 只收扩展源（plugin/skill 两种 owner）；用户源走闭包快照独立通道 |
| "makeDeps 构造时把配置汇集了" | 构造只插五根线；构造时刻注册表是空的（loadAll 在后），汇集在每次 dispatch |
| "mcp_tool 占位 = MCP 用不了" | MCP 工具（M6）完全可用；占位的只是"hook 的执行体形态"这一种写法 |
| "hooks 各源各自执行各自的" | 三源在 specsFor 拼成一张表后，同一个 for 循环、同一个执行器、同一份聚合 |
| "是 hook 找事件" | 是事件找 hook（拉模型）：每次 dispatch 现场查表 filter，无订阅无解绑 |
| "黑名单是权限系统" | 是 8 条防手滑正则（防删根/提权/fork炸弹）；细粒度权限是 M8 §12 储备 |

---

## 附录 A：代码锚点总表

| 环节 | 文件:行 | 职责 |
|---|---|---|
| 事件全集 | `hooks/types.ts:10-17` | HOOK_EVENTS 六事件封闭集 |
| 绑定结构 | `hooks/types.ts:35-42` | HookSpec（event/matcher/handler/timeout） |
| 执行体形态 | `hooks/types.ts:22-32` | command 已实现；mcp_tool/prompt 占位 |
| 协议出参 | `hooks/types.ts:62-82` | HookOutput 五字段 / HookVerdict |
| 用户源校验 | `hooks/validate.ts:49-80` | parseHookSpecs（三源共用，AJV） |
| 扩展注册表 | `hooks/registry.ts:18-48` | Map 存储；specs() 展平 |
| 全局单例 | `hooks/global.ts:7` | globalExtensionHooks + skill 注册三函数 |
| 匹配器 | `hooks/matcher.ts:9-23` | 字面量/列表/正则三形态，容错回退 |
| 分发器 | `hooks/runner.ts:62-92` | dispatch：补 id → 查询 → 循环执行 → 聚合 |
| fail-open | `hooks/runner.ts:95-104` | runOne 兜底：失败→warn+null |
| 子进程执行器 | `hooks/exec.ts:20-94` | 黑名单/超时/平台分流/stdin/退出码协议 |
| stdout 白名单 | `hooks/exec.ts:97-115` | 五字段过滤，未知剥离 |
| 工具装饰层 | `tools/hooked.ts:19-99` | Pre/Post 三明治；getter 约束 |
| 装配 | `cli/index.ts:99-110` | 解析用户源 → 插线 → 装饰 |
| 插件资源接入 | `plugin/loader.ts:532-573` | loadOne 四类分发 |
| 插件卸载链 | `plugin/loader.ts:466-501` | teardown 五步镜像 |
| 插件命令注册 | `plugin/loader.ts:576-612` | /插件名:命令 |
| 插件 hooks 入队 | `plugin/loader.ts:568-570` | register('plugin:名@市场') |
| 黑名单 | `proc.ts:55-68` | DANGEROUS_PATTERNS 八条（与 bash 工具共用） |

## 附录 B：横向规模对照

设计裁剪的参照系（一手源码调研，2026-08-15）：hooks 代码量 ECode 589 行 / opencode ~2,200（进程内 JS 插件路线）/ Claude Code ~4,900（25 事件、5 执行体、7 源）/ codex ~12,400（11 事件、4 执行体、10 源）。ECode 的取舍：6 事件、1 执行体、3 源、协议字段与 Claude Code 同名对齐（现成 hook 脚本基本直接能跑）——靠裁剪换来的最小实现，复杂度集中在子进程协议层（这是选 command 形态的固定成本，不是总线本身的复杂度）。
