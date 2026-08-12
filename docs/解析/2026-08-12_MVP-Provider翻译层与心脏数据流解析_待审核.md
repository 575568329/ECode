---
layer: n/a
status: review
related_adr: []
reviewed_doc: [详设/2026-08-11_ECode-MVP详设_待审核.md]
---

# ECode MVP Provider 翻译层与心脏数据流解析

> 解析日期：2026-08-12 · 状态：待审核
> 本文剖析 M1 已实现的「服务器事件 → 心脏 Delta」翻译流，以及 CLI 到 loop 的调用链与两层循环机制。
> 配合 `src/providers/anthropic.ts`、`src/core/loop.ts`、`src/cli/index.ts` 阅读。结论落自一次真实抓包 + token 计数 bug 排查（commit f6db671）。

---

## 0. 这篇文档讲什么

M1 心脏已跑通，但「服务器到底返了什么 → 怎么变成心脏能消费的 Delta → 谁在驱动循环」这条链路散在三个文件里。本文把这条链路拆成 7 块，每块配流程图，对着代码读一遍。

**核心一句话**：心脏（`runLoop`）永远只消费规范 `Delta`，而 `Delta` 是 `Translator` 把服务器 SSE 事件翻译出来的——协议差异全封在 Provider 内部，心脏零 provider 判断。

---

## 端到端数据流脑图（导读）

整篇文档的地图——从 `main()` 启动到 loop 退出，数据怎么流、模块怎么组装、接口怎么调、状态机怎么转、循环怎么走、工具何时调、退出由谁定。各环节的展开见后续章节。

```
main() 启动
├─ ① loadConfig()                 读配置 → cfg（model/baseURL/apiKey/type）
├─ ② makeDeps(cfg)                组装 + 注册 → Deps
│   ├─ 注册 Provider              new AnthropicProvider → providerReg.register()
│   ├─ 注册 Tool                  read_file, bash → toolReg.register()
│   ├─ Logger / History           直接 new（不走 registry）
│   └─ → Deps { provider, tools, logger, history, cfg }
├─ ③ runOnce(msg, input, deps)            跑一次对话（注入参数 + 调 loop）
│   └─ runLoop(msg, input, opts)          Agent 迭代循环（for iter）
│       └─ 每轮 iter：
│           ├─ A. provider.run(req)       调接口（HTTP POST + SSE 流）
│           │     【SSE 事件】→ Translator 状态机 → 【Delta】   （见 §3 §4）
│           ├─ B. 消费 Delta，组装数据     textBuf / newToolUses / stopReason / usage
│           ├─ C. finally 固化            assistant 消息 push 进 messages
│           ├─ D. 退出判定（看 stopReason）                         （见 §7）
│           │     ├─ end / aborted / length → break
│           │     └─ tool_use → 继续 ↓
│           └─ E. executeTools → invokeTool → tool.execute          （见 §6）
│                 └─ tool_result 回喂 messages → 下一轮 iter
└─ 退出（单次 process.exit / REPL 等下一行）
```

各阶段的「数据形态」（cfg / Deps / req / Delta / Message）见对应章节。

---

## 1. 全景：一次请求的完整数据流

用户问「读 package.json」，到模型流式回答，中间经过 4 个阶段：

```
用户输入 "读 package.json"
   │
   ▼
[1] main()                              ── src/cli/index.ts
    loadConfig() → makeDeps(cfg) → runOnce(messages, input, deps)
   │
   ▼
[2] runOnce()                           ── src/cli/index.ts
    把 deps 拆开 + 注入 callbacks/providerReq → await runLoop(...)   ★扣扳机
   │
   ▼
[3] runLoop() 内层 for 迭代              ── src/core/loop.ts
    ┌─► provider.run(req)  ──HTTP POST──►  Astron 服务器（模型在这）
    │      ◄──── SSE 事件流（message_start / content_block_* / message_delta ...）
    │   │
    │   ▼
    │   Translator 翻译 事件 → Delta      ── src/providers/anthropic.ts
    │   │
    │   ▼
    │   拼文字 / 拼工具入参 → 执行工具（read_file / bash）→ 把结果回喂
    │   │
    └──┘ LLM 还要调工具就继续，说 end_turn 就停
   │
   ▼
[4] 流式输出到终端（onText / onToolStart / onUsage）→ 等下一次输入(REPL) 或 exit(单次)
```

后面 6 块分别钻进 [2][3] 这条链的每个环节。

---

## 2. Provider 翻译层（src/providers/anthropic.ts）

### 2.1 文件地图

整个文件是一个「翻译器」，分 6 块：

| 块 | 职责 | 方向 |
|---|---|---|
| `RawUsage` / `RawEvent` | Anthropic 事件的宽松类型（不硬依赖 SDK 内部类型） | 入 |
| `mapStopReason` | 停止原因翻译小表（`max_tokens`→`length` 等） | 入 |
| `Translator` | **★有状态翻译器**：事件→Delta，持有 index→id 映射 | 入 |
| `translateAnthropicStream` | `Translator` 的批处理壳（纯函数，给单测用） | 入 |
| `toAnthropicMsgs` | 规范 Message → Anthropic 协议（结构贴近，基本透传） | **出** |
| `AnthropicProvider` | 实现 `LLMProvider`，把 SDK 流接上 `Translator` | 入 |

「入」= 响应（模型→我们），「出」= 请求（我们→模型）。难点全在「入」。

### 2.2 两个方向为什么不对称

```
出方向（请求）：toAnthropicMsgs —— 基本透传（规范模型本就照 Anthropic 设计）→ 几行代码
入方向（响应）：Translator —— 有状态机翻译 → 整个文件的密度所在
```

> 预告：M3 加 `OpenaiProvider` 时，「出方向」也得真翻译了（system 要塞进 messages[0]、tool 结构不同）——那时翻译层才真正两头吃重。

---

## 3. 事件流的来源：SSE 协议

### 3.1 事件是服务器推的，不是我们造的

**铁证**：绕过 SDK，直接 `fetch` 端点（`scripts/raw-sse.ts`），服务器返回 `HTTP 200 + content-type: text/event-stream`，然后一条长连接里逐帧推文本。每一帧的 `event:` 行都是服务器写的。

```
── SSE 帧[3] ──
event: content_block_start                              ← 服务器声明的帧类型
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
                                                         ← 事件的 JSON 载荷
```

`message_start` / `content_block_start` / `content_block_delta` / `message_delta` 这些**全是服务器在生成回复过程中按协议推过来的**，事件里的内容（文字、工具入参）则是背后的大模型生成的。

### 3.2 SSE 帧格式

```
event: <帧类型>\n          ← 这帧是什么事件
data: <JSON>\n             ← 事件的 JSON 数据
\n                         ← 空行 = 一帧结束
```

服务器边生成边把帧顺着同一条 HTTP 连接推过来（连接不断开），客户端边收边处理。这就是「流式」。

### 3.3 SDK 的角色：过滤 + 解析，不造事件

| SDK 的动作 | 例子 |
|---|---|
| ① 过滤掉无关帧 | `event: ping`（心跳保活）被丢弃 |
| ② 把 data 的 JSON 解析成对象 | `data:{...}` → `{type:'content_block_start',...}`，去掉 `event:` 行 |

SDK **只在 data 里有时才解析**，绝不凭空生成 `content_block_start`。原始帧有它 → SDK 事件对象才有它，一一对应。

### 3.4 真实抓包帧序列（一次「先说话、再调工具」的请求）

```
帧[ 1] message_start        usage={in:0, out:0}              ← Astron 在 start 报 0/0
帧[ 2] ping                                                  ← 心跳，SDK 丢弃
帧[ 3] content_block_start  idx=0 type=text                  ← 开文字块
帧[4-14] content_block_delta idx=0 text_delta ×11            ← "好的，我马上为你读取…"
帧[15] content_block_stop   idx=0
帧[16] content_block_start  idx=1 type=tool_use id=call_…    ← 开工具块（id 只在这出现一次）
帧[17-23] content_block_delta idx=1 input_json_delta ×7      ← 入参 JSON 切成 7 片
帧[24] content_block_stop   idx=1
帧[25] message_delta        stop=tool_use usage={in:166,out:23,cache_read:0}  ← 真值在这
帧[26] message_stop
```

注意帧[1] 和帧[25] 的 usage——这是后面 token bug 的现场（见第 5 块）。

---

## 4. Translator 状态机：index → id 映射

### 4.1 为什么必须有状态——分清「判类型」和「判归属」

**判类型**（文字？工具入参？）：**不需要状态**。`delta.type` 自带（`text_delta`/`input_json_delta`/`thinking_delta`）。

**判归属**（这个工具入参属于哪个工具调用 / id 是几）：**必须靠状态**。`input_json_delta` 事件只带 `index`、**不带 id**，但规范 `tool_use_delta` 必须带 id。id 只在 `content_block_start(tool_use)` 出现一次 → 必须先记下、delta 时按 index 查回来补上。

### 4.2 状态字段（Translator 类）

| 字段 | 作用 |
|---|---|
| `blocks: Map<index, {kind,id,name}>` | **核心**：index→身份映射，给工具入参补 id |
| `stopReason` | 攒停止原因（message_delta 才给，flush 时发） |
| `usageInput/Output/cacheReadTokens` | 攒 token 计数 |
| `sawUsage` | 是否见过 usage（决定 flush 要不要发 usage） |

### 4.3 逐事件翻译流程（以工具块 idx=1 为例）

```
content_block_start  idx=1  tool_use id=call_A name=read_file
   │
   ├─► blocks.set(1, {kind:'tool_use', id:'call_A', name:'read_file'})   ★建表
   └─► 发 Delta: tool_use_start(id=call_A, name=read_file)

content_block_delta  idx=1  input_json_delta partial_json='{"path":'
   │
   ├─► 查 blocks.get(1) → id=call_A        ★id 是查表补回来的（delta 本身没 id）
   └─► 发 Delta: tool_use_delta(id=call_A, '{"path":')

content_block_delta  idx=1  input_json_delta partial_json='"a.ts"}'
   │  （同上，再发一条 tool_use_delta）

content_block_stop  idx=1
   │
   ├─► 发 Delta: tool_use_end(id=call_A)
   └─► blocks.delete(1)                     ★清表（防内存累积、防 index 复用串台）
```

### 4.4 多工具并行时为什么这套状态不可省

LLM 一轮可同时调多个工具，delta 是**交错到达**的：

```
content_block_start  idx=1  tool_use id=call_A name=read_file
content_block_start  idx=2  tool_use id=call_B name=bash
content_block_delta  idx=1  input_json_delta '{"path"'     ← 查表 → call_A
content_block_delta  idx=2  input_json_delta '{"cmd"'      ← 查表 → call_B
content_block_delta  idx=1  input_json_delta ':"a.ts"}'    ← call_A
```

没有 index→id 映射，这些 JSON 碎片就串不成两个完整的工具入参。**index 是轻量位置号，id 是逻辑身份**——协议用前者寻址、后者只在 start 发一次，所以翻译层必须**有状态**地持有这张表。

---

## 5. token usage 聚合：bug 与修复

### 5.1 usage 为什么分两个事件披露

流式协议的本质决定：

- **input**（system + messages + tools）：请求发出的那一刻就定死 → 立刻能算 token 数。
- **output**（模型回复）：边生成边长 → 只有流结束才知道总数。

所以协议分两次披露：`message_start` 给 input 真值 + output 占位（0/1）；`message_delta` 给 output 累积终值（官方原话：_"cumulative"_）。

### 5.2 标准端点 vs Astron 的分歧（真实抓包）

| 事件 | 标准 Anthropic | **Astron/GLM（实测）** |
|---|---|---|
| `message_start.usage` | `{in:170, out:1}` | `{in:0, out:0}` |
| `message_delta.usage` | `{out:23}` | `{in:166, out:23, cache_read:0}` |

标准端点 input 在 start 给真值；**Astron 在 start 报 0/0，真值全塞 message_delta**。这是 Astron 兼容层的实现偏差，不是我们触发的 bug——但必须兜住。

### 5.3 旧写法为什么挂——一个「碰巧成立」的脆弱假设

旧 `Translator`：`message_start` 读 input 当终值，`message_delta` 只覆盖 output，**不碰 input**。

**隐含假设：input 在 message_start 一次定死。**

| 端点 | start 存的 input | delta 碰 input | 最终 | 对？ |
|---|---|---|---|---|
| 标准 | 170 | 不碰 | 170 | ✅ |
| Astron | 0 | 不碰 | **0** | ❌ 真值 166 在 delta 却没读 |

不是逻辑写错，是**假设太强**。测试 fixture 把 input 全写在 message_start 里，等于把假设硬编码进测试 → 45 个用例全绿，真实一跑 input=0。

### 5.4 守卫覆盖机制（修复后，对齐主流）

新写法：`message_delta` 的 input/cache 也读，加 `!= null` 守卫。

```
                    message_start         message_delta               最终 input
标准端点   input:  200(真)                (字段缺失/null)              200 ✓ 保留初值
                                    守卫 !=null 不通过 → 不覆盖

Astron     input:  0                     166(真)                      166 ✓ 覆盖
                                    守卫 !=null 通过 → 覆盖

output:    占位 0/1                      23(累积)                     23 ✓ 无条件覆盖
```

**守卫的真正作用**：让「input 终值到底在哪个事件给」变得无关紧要——标准端点在 start 给、兼容端点在 delta 给，两种情况都能拿到真值。代码甩掉了「input 一定在 start」这个脆弱假设。

### 5.5 主流库对齐（本地源码交叉验证）

| 库（本地版本） | output | input 读 message_delta？ | 合并方式 | 兜住 Astron？ |
|---|---|---|---|---|
| `@anthropic-ai/sdk` **0.40.1** | delta 覆盖 | 否 | 字段覆盖 | ❌（旧写法） |
| `@anthropic-ai/sdk` **0.115.0** | delta 无条件覆盖 | **是**（`!=null` 守卫） | 字段覆盖 | ✅ |
| Vercel `@ai-sdk/anthropic` | delta 无条件覆盖 | **是**（`!=null && !==` 双守卫） | 字段覆盖+spread | ✅ |
| `@langchain/anthropic` | delta 取（下游加法） | 否，硬编码 0 | **加法累加** | ❌（还双倍计 cache） |

三条铁律（官方 SDK + Vercel 共识）：
1. `output_tokens` 无条件覆盖（累积语义，绝不加法）
2. `input_tokens` / cache 字段 `!= null` 才覆盖（防标准端点 delta 缺字段时冲掉真值）
3. **永远不要加法累加**（LangChain 前车之鉴：双倍计数）

> 注：守卫覆盖是 `0.40.1 → 0.115.0` 之间才加的改进；ECode 锁的 `^0.40.1` 卡在改进之前。但 ECode 不走 SDK 的 MessageStream 累积（自己写 Translator 直接消费 raw 事件），所以与 SDK 版本无关，自己实现对齐守卫覆盖即可。

---

## 6. CLI 调用链：makeDeps / runOnce / runLoop

### 6.1 三层分工

| 层 | 函数 | 文件 | 角色 | 类比 |
|---|---|---|---|---|
| 装配 | `makeDeps(cfg)` | cli/index.ts | 把 config 转成 Deps（注册 provider/tools，new logger/history） | 备料（全程一次） |
| 启动 | `runOnce(msg,input,deps)` | cli/index.ts | 注入 callbacks/providerReq → 调 runLoop | 下锅开火（每轮一次） |
| 运行 | `runLoop(msg,input,opts)` | core/loop.ts | AgentLoop 主循环 | 锅里翻炒（for 迭代） |

### 6.2 调用链流程图

```
main()                                    ── 程序入口（#! 指向这里）
  ├─ loadConfig()            读配置         「模型怎么连」
  ├─ makeDeps(cfg)  ★装配    cfg → Deps     注册 AnthropicProvider + read_file + bash
  │                                         （加 provider/tool 只改这里，loop 零改动）
  └─ runOnce(messages, input, deps)  ★启动  单次模式调 1 次 / REPL 每行调 1 次
       │   拆 deps + 注入 callbacks + 拼 providerReq
       └─ runLoop(messages, input, opts)    ── loop 本体入口（core/loop.ts）
            └─ for 迭代  ★内层循环
```

### 6.3 makeDeps：装配工厂（不是获取项目信息，也不是 loop 入口）

- 输入 `M1Config`（模型连接配置：type/baseURL/apiKey/model）——**不是「项目信息」**。
- 输出 `Deps = { provider, tools, logger, history, cfg }`——装的是「能力」，不读任何项目文件。
- 「项目信息」（文件/命令/代码结构）是工具运行时读的，跟 makeDeps 无关。
- 装了两类东西：**能力实现**（provider/tools，按 type 注册）+ **配置实例**（cfg，按 name 区分连哪个端点）——呼应「实现按 type / 配置实例按 name」两层架构。

### 6.4 runOnce：启动层（不是装配）

函数体本质就是一句 `await runLoop(messages, input, { ...opts })`，前面所有代码都在构造传给 runLoop 的 opts（callbacks 怎么输出到终端、providerReq 连哪个端点、system、maxIterations、toolCtx）。**调 runLoop 那一刻，循环启动。**

---

## 7. 两层循环：人控 vs 机控

### 7.1 两层循环流程图

```
外层循环（人控 · readline）              内层循环（LLM 控 · runLoop 的 for）
══════════════════════════              ══════════════════════════════════
用户回车 ─► runOnce ─► runLoop ─────►┌─► 调 provider.run()
                                     │   收 Delta、拼文字/工具入参
                                     │   执行工具、回喂结果
等待下一行输入 ◄─────────────────────┘   （LLM 说 end_turn 就停）
   (messages 跨轮累积 → 连续对话)        (单次/REPL 每次都跑这套)
```

### 7.2 外层：人控节奏（只有 REPL 有）

`readline` 的 `'line'` 事件：用户每按一次回车 → 触发一次 `runOnce`。不输就不转，Ctrl+C/EOF 就停。**对话节奏由人掌握。** 单次模式（argv 带问题）没有这层，调一次就 exit。

### 7.3 内层：LLM 控求解（两种模式都跑）

每次 `runOnce → runLoop` 后，loop 自己反复「调模型 → 跑工具 → 回喂」，但**转不转的最终决定权在 LLM**：

| LLM 表态（stop_reason） | loop 动作 |
|---|---|
| `end_turn`（"答完了"） | 停 |
| `tool_use`（"要调工具"） | 执行工具 → 继续 |
| `length`（被截断） | 提示 + 停 |
| 致命错误 | 抛出中断 |

`maxIterations`（默认 50）只是兜底，防 LLM 失控死循环。

### 7.4 messages 跨轮共享（REPL 连续对话的来源）

`main` 里 `messages` 只创建一次，REPL 每轮都把**同一个数组**传给 `runOnce`：

- **REPL**：messages 跨轮累积 → 第 2 轮能看到第 1 轮对话 → 连续对话（有上下文）
- **单次**：messages 用一次就 exit → 一次性，无上下文

### 7.5 一句话本质

> **外层循环是「人机对话」的节拍（用户驱动），内层循环是「机器解题」的节拍（LLM 驱动，loop 配合执行）。** 这正是 Agent 跟传统 CLI 的根本区别——传统 CLI 一条指令一个动作；Agent 一条指令，机器自己反复「思考→行动→观察」直到完成。内层循环就是这个「反复」的载体。

---

## 8. 工具来源扩展性：为什么 loop 不会膨胀

一个常被问到的担忧：后期接 skill / MCP / plugin，会不会全塞进 `loop.ts` 导致膨胀？**不会。**

### 核心认知：loop 对工具来源是盲的

skill / mcp / plugin 在 ECode 里最终都是「工具」——它们各自被适配成统一的 `Tool` 接口，注册进 `ToolRegistry`。loop 只调 `tool.execute()`，**不知道也不关心这个工具是 builtin 的 read_file、还是 MCP 来的、还是 skill 来的**。

```
工具来源（多样）              adapter（适配成 Tool 接口）      ToolRegistry        loop
──────────────               ──────────────────────────      ──────────         ────
builtin read_file/bash   ──┐
MCP server 的工具        ──┼─► 包装成 { name, schema,   ──► register ──► 存 ──► executeTools
skill 里的能力           ──┤       readonly, execute }                              ↓
plugin 提供的工具        ──┘                                                  invokeTool → tool.execute()
                                                                        （loop 不知道来源）
```

### 加 skill/mcp/plugin 时改哪里

| 改哪里 | 改 loop.ts？ |
|---|---|
| 写 adapter（MCP client / skill loader / plugin loader） | ❌ |
| `makeDeps` 多几行 `register` | ❌ |
| `tools/` 目录多几个 adapter 文件 | ❌ |

**`loop.ts` 一行都不改。** 膨胀的是 `tools/`（adapter）和 `makeDeps`（注册），不是心脏。

### MCP 接入示例（全在 adapter，不碰 loop）

```ts
// tools/mcp-adapter.ts（未来）
const mcpTools = await mcpClient.listTools()      // 拿 MCP server 的工具
for (const t of mcpTools) {
  toolReg.register(adaptMcpTool(t))               // 包装成 Tool 接口注册
}
// adaptMcpTool：MCP 工具的 schema/call → ECode 的 Tool { name, input_schema, execute }
```

loop 照样 `tool.execute()`，根本感觉不到这是 MCP 来的。

### 职责边界

`loop.ts` 只管「循环 + 工具调度」（`runLoop` / `executeTools` / `invokeTool`），不管「工具从哪来、怎么实现」。来源多样性是 Registry 和 adapter 的事——这正是「两个 Registry 是可插拔分支面」的核心价值：**扩展能力的多样性由 adapter 吸收，心脏只认统一接口，永远不膨胀**。

---

## 附：关键代码锚点速查

| 概念 | 位置 |
|---|---|
| 规范模型（Delta / Message / AppError） | `src/core/types.ts` |
| AgentLoop 主循环 + 内层 for | `src/core/loop.ts` 的 `runLoop` |
| 错误二分（recoverable / fatal） | `src/core/errors.ts` |
| 协议事件 → Delta 翻译 + 状态机 | `src/providers/anthropic.ts` 的 `Translator` |
| usage 守卫覆盖（本篇第 5 块） | `Translator` 的 `message_delta` 分支 + `flush` |
| 出方向：规范 Message → Anthropic 协议 | `src/providers/anthropic.ts` 的 `toAnthropicMsgs` |
| 装配工厂 | `src/cli/index.ts` 的 `makeDeps` |
| 启动层 | `src/cli/index.ts` 的 `runOnce` |
| 程序入口 + 外层 readline 循环 | `src/cli/index.ts` 的 `main` |
| 直连端点看 SSE 原始帧（调试） | `scripts/raw-sse.ts` |
| token 修复提交 | commit `f6db671` |
