# 踩坑记录

> 跨设备同步（git 跟踪）。遇到非显而易见的坑，记这里；解决后更新"解决"段。
> 索引在 [MEMORY.md](./MEMORY.md)。

---

## #001 `--env-file` 不覆盖已存在的环境变量

**日期**：2026-07-29
**影响**：`.env` 配置"看起来没生效"，模型/端点被悄悄替换。

### 现象
在 Claude Code 环境里跑 `npm run dev -- "任务"`，`.env` 里写的 `ANTHROPIC_MODEL=deepseek-v4-pro`，但运行时打印 `model: GLM-5.2`——配置被忽略了，且请求实际打到了别的端点（用父进程的 env 跑通了）。

### 根因
Node 的 `--env-file` / `--env-file-if-exists` 语义是**只设置尚未存在的变量，不覆盖**：
- Claude Code（harness）启动时已向进程注入了一整套 `ANTHROPIC_*` 环境变量（来自 settings.json 的 `env` 块）。
- 这些继承来的变量优先级高于 `.env` 文件，导致 `.env` 里的同名值被压过去。

### 判断方法
打印实际生效的值，别假设 `.env` 一定会赢：
```bash
node -e "console.log(process.env.ANTHROPIC_MODEL)"
```

### 解决
- **普通终端**（没有 export 过 `ANTHROPIC_*`）：不受影响，`.env` 正常生效，无需处理。
- **在已注入 env 的环境里调试**：用干净环境跑，强制只用 `.env`：
  ```bash
  env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" USERPROFILE="$USERPROFILE" \
    npx tsx --env-file-if-exists=.env src/index.ts "任务"
  ```
  注意 `env -i` 会清掉 `TMPDIR`，见下方 #002。
- **若希望 `.env` 强制覆盖**：在代码里显式读 `.env` 并覆盖 `process.env`（如引入 dotenv，它默认覆盖），但这与 Node 原生语义相反，按需取舍。

---

## #002 `env -i` 清空 TMPDIR 导致 tsx 缓存写到 `./undefined/`

**日期**：2026-07-29
**触发场景**：配合 #001 用 `env -i` 跑测试时。

### 现象
项目根目录冒出一个 `undefined/temp/tsx-about/...` 目录，里面是 tsx 的编译缓存。

### 根因
`env -i` 清空了所有环境变量，tsx 找不到临时目录变量（`TMPDIR` / `TEMP` / `TMP`），回退成字符串拼接 `"undefined/temp/..."` 写到**相对路径**（当前工作目录下）。

### 解决
用 `env -i` 时手动保留临时目录变量：
```bash
env -i PATH="$PATH" TMPDIR="$TMPDIR" TEMP="$TEMP" TMP="$TMP" \
  SYSTEMROOT="$SYSTEMROOT" npx tsx ...
```
测试产生的 `undefined/` 目录直接 `rm -rf` 删掉即可，不入库。

---

## #003 fast-glob 3.x ESM 无 named export（vitest 假过，Node 运行时才报错）

**日期**：2026-07-30
**影响**：vitest 测试全绿，但 `npm run dev` 实跑 `SyntaxError: does not provide an export named 'glob'`。

### 现象
`import { glob } from 'fast-glob'` —— vitest 跑 glob.test.ts 全过；`npm run dev` 实跑报 `The requested module 'fast-glob' does not provide an export named 'glob'`。

### 根因
- fast-glob 3.x 的 ESM 只有 **default export**（函数），没有 named export `glob`。
- **vitest 用 vite/esbuild 做模块互操作，对 CJS→ESM 的 named import 宽容**（把 default 当属性来源），导致测试"假过"。
- Node 原生 ESM 严格，named import 必须真实存在，实跑才暴露。

### 解决
用 default import：
```ts
import fg from 'fast-glob';
const files = await fg(pattern, { ... });
```

### 教训
**vitest 测试过 ≠ Node 运行时正常**（ESM/CJS interop 差异）。涉及第三方库 import 时，务必用 `npm run dev` 实跑验证，不能只靠 vitest。

---

## #004 LLM 既有知识写"具体数值"会失真——设计文档必须核查源码/官方文档

**日期**：2026-08-03
**性质**：方法论踩坑（非代码 bug），跨项目通用
**影响**：M3 设计文档（实施方案 + 方案解析）出现多处失真数据，险些带病进入 TDD 编码；被用户发现后全量返工核查。

### 现象

写 M3 上下文管理设计文档时，凭 LLM 既有知识写了以下内容，后被用户发现**全部失真**：

| 断言类型 | 我写的（错） | 核查后（对） |
|---------|------------|------------|
| 模型上下文窗口 | GLM-5.2 ~128k | GLM-5=200K / **GLM-5.1+=1M** |
| 模型上下文窗口 | DeepSeek ~64k | V3/V3.1/R1=128K / **V4=1M** |
| 库的支持范围 | ai-tokenizer "覆盖 GLM/DeepSeek" | **无原生 encoding** |
| 库的能力 | ai-tokenizer "90+ 模型" | 捏造（无此数据） |
| 库的准确率 | ai-tokenizer "97%+" | 仅限顶级模型，第三方测评有争议 |
| 实现机制 | "Claude Code/opencode 用 80% 百分比阈值" | Claude Code 用**绝对 token 数 167K**（≈83.5%） |

### 根因

- **LLM 训练数据有截止日期**：版本号 / 窗口大小 / 库的支持范围这类"快速变化的具体数值"最容易过时失真。
- **LLM 对这类问题不会说"我不知道"**：而是用旧知识"流畅地编一个看起来合理的数"——越具体（精确到数字）、越是排他性断言（"覆盖 XX""就是这么做"），失真风险越高。
- **抽象内容可信，具体数值不可信**：概念解释 / 架构模式 / 设计权衡这类变化慢的，LLM 知识基本可靠；一旦落到"某模型某版本某数字""某库支持某模型""某项目某行代码就是这么写"，就必须核查。

### 解决（三源核查法）

设计文档中凡涉及**具体数值 / 库支持范围 / 协议机制**，走三源核查：

1. **源码**：本地有的源码库（`D:\Study\claude-code-main` / `D:\Study\CCode` / `D:\Study\vercel-ai-sdk`）派 Agent 逐行核实，引用 `file:line`。
2. **官方文档 / 模型卡**：WebSearch 查模型窗口、库的 supported models 列表（Atlas Cloud / 阿里云 / OpenRouter 等）。
3. **第三方测评**：对厂商声明（如"97% 准确率"）找独立测评交叉验证，不照单全收。

**核查产物**：每个数值 / 实现断言带 `file:line` 或 URL 出处（正文用 📌 标记），让"我说的"可被读者复验。

### 教训（通用原则）

> **写设计文档时，"具体数值"类断言 = 核查红线。**
>
> - 高风险（必须核查）：版本号 / 窗口大小 / 库支持范围 / 性能数字 / "XX 就是这么做的"实现细节。
> - 低风险（可凭知识）：概念解释 / 架构模式 / 设计权衡这类变化慢的抽象内容。
>
> 触发信号：当自己要写下一个精确数字、或一句"XX 支持/覆盖 XX"时，停下来问"这个我核查过吗？出处是哪？"——答不上来就去查，别凭记忆写。

### 关联

- 导致的决策修订：[decisions.md #001](./decisions.md)（ai-tokenizer → length/4）
- 跨项目沉淀（含可执行清单）：`ai-task-flow/knowledge-base/项目复盘/20260803_AI知识时效性失真_设计文档数值核查.md`

---

## #005 上下文超限死局——"超限后无法压缩"的响应式恢复

**日期**：2026-08-03
**性质**：设计增强（非 bug），M3 P3 之后插队
**影响**：用户高频触发 `API Error: The model has reached its context window limit`，超限后 API 直接 400、压缩没机会触发、任务死。

### 现象与根因

`maybeCompress` 只在每轮 API 调用**前**触发。一旦已经超限，`withRetry` 把 400 当不可重试直接抛 → agent 崩，压缩根本没机会跑。三个漏洞：

1. **无响应式恢复**：API 报 context-window 错 → `retry.ts` 当 400 直接抛 → agent 死，没有"报错→强制压缩→重试"路径。
2. **recent 窗口本身超限**：一次 read_file/grep 回来 6 万 token 塞进 recent 6 轮 → `[summary, ...recent]` 还是超限 → 下一轮 API 还是 400。LLM 摘要压不动已经在保留区的内容。
3. **token 低估**：纯 `length/4` 对某些内容低估 → maybeCompress 认为没超阈值 → 不压缩 → API 400。

### 成熟方案（源码核查，非瞎想）

| 层 | 出处 | ECode 落地 |
|---|---|---|
| L2 tool-result 内容清空 | Claude Code `microCompact.ts:36 TIME_BASED_MC_CLEARED_MESSAGE` / CCode `context-manager.ts:206 ToolResultTrimStrategy` | `trimToolResultContents`：把旧 tool_result 的**内容**换占位符，**保留 tool_use_id** → 配对不断裂，零 LLM 成本，完全安全 |
| L3 响应式恢复 | Claude Code `query.ts:1119 reactiveCompact.tryReactiveCompact` + `errors.ts:62 isPromptTooLongMessage` | `isContextWindowError` + `forceCompact`：捕获 API 超限错 → 激进 trim(keepRecent=1)+summary(keepRounds=2) → 重试一次 |
| L4 熔断 | Claude Code `autoCompact.ts:70 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`（注释原话：1,279 sessions 50+ 次失败烧 25 万 API/天）| `forceCompact` 返回 null = 压到极限仍超限 → 放弃恢复抛清晰错，防"compact→still too long→compact"死循环 |
| 级联 | CCode `context-manager.ts:399 prepare`（先 tool-trim 不够再 summary）| `maybeCompress` 改级联：超阈值先 trim（便宜），够就不调 LLM，仍超才上 summary |

关键洞察：**L2 trim 是处理漏洞②的唯一手段**——LLM 摘要压不动 recent 里的内容，但 trim 能直接清空它的内容（保留 id 不破坏配对）。所以级联必须先 trim 再 summary。

### ECode 实现（`src/context-manager.ts` + `src/agent.ts`）

- `trimToolResultContents(messages, keepRecent=3)`：纯函数，输出仍是 `ECodeMessage[]`（数据结构不变，满足用户约束）。
- `isContextWindowError(err)`：覆盖 GLM"context window limit"/Anthropic"prompt is too long"/OpenAI"maximum context length"/"context_length_exceeded"。
- `forceCompact(messages, opts)`：激进压缩，返回非 null = 已低于阈值；null = 熔断。
- `maybeCompress`：级联 trim→summary。
- `agent.ts`：把 `provider.complete` 包进 try/catch，context-window 错 → `forceCompact` → 用恢复后的 messages 重试一次。

### 教训

> **上下文管理不能只有"主动压缩（调用前）"，必须有"响应式恢复（API 报错后）"。**
> 主动压缩靠估算，估算会偏（低估）；单步大工具结果会一步超限。一旦 API 报错就死，等于把"能否继续"全压在估算准确率上——这是脆弱设计。响应式恢复是兜底：错了能自救，自救不了才熔断退出（而不是死循环烧 API）。

### 验证

`tests/context-resilience.test.ts`（20 测试）：trim 保留最近N个/配对不断裂/不可变、isContextWindowError 多协议措辞、forceCompact 三路径（trim够/trim不够上summary/熔断null/异常null）、maybeCompress 级联。全量 130 测试通过，tsc clean。

### 关联

- 设计出处核查：`D:\Study\claude-code-main\src\services\compact\{autoCompact,microCompact}.ts`、`src\query.ts:1065-1183`、`src\services\api\errors.ts:62-77`、`D:\Study\CCode\cCli\src\core\context-manager.ts:200-246`
- [M3-方案解析 §五](../M3-方案解析.md) 踩坑预警（本文补充其 §5.5 未覆盖的"API 报超限后恢复"）

---

## #006 GLM coding plan 端点：`coding/paas/v4` vs `paas/v4`

**日期**：2026-08-04
**性质**：配置 / 排障（非代码 bug）
**影响**：GLM 请求报 429，曾长期误判为额度耗尽。

### 现象

P4 真机落盘验证时 GLM 持续 429，一度归因配额耗尽。核查端点配置后发现关键差异：ECode 此前默认 `https://open.bigmodel.cn/api/paas/v4`（非 coding），而用户用的是**智谱 coding plan 套餐**。

### 根因（推断，部分待真机验证）

- 智谱 **coding plan 套餐**专用端点含 `/coding/`：`https://open.bigmodel.cn/api/coding/paas/v4`。
- **CCode 源码默认值就是 coding 端点**（`D:\Study\CCode\cCli\src\config\config-manager.ts:53`），且 CCode README 声明"全程在智谱 GLM 下开发测试"、多家企业生产使用——可信度高。
- ECode 此前默认 `paas/v4`（非 coding），coding plan 的 key 打普通端点很可能因套餐不匹配 → 429。
- ✅ **已真机验证**（2026-08-04）：默认改 coding 端点后跑简单任务，GLM 正常响应、**429 消失**——端点不匹配确为 429 根因（非配额耗尽）。

### 解决

- GLM 默认 baseURL 改为 `coding/paas/v4`（对齐 CCode），见 `src/providers/config.ts` 的 `DEFAULT_CONFIG`。
- baseURL 三级可配（`resolveBaseURL`）：① `GLM_BASE_URL`（.env）② config.json `providers.X.baseURL` ③ 内置默认。非 coding plan 用户：`GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`。
- 单测覆盖解析逻辑（`tests/providers/config.test.ts` resolveBaseURL 五路径）；端点→429 因果**已真机验证**（2026-08-04 默认改 coding 端点后 429 消失）。

### 教训

> **同一家厂商不同套餐 / 产品线可能有不同端点。** 排查 429 / 401 / 404 类错误时，除了查额度和 key，还要核查 baseURL 是否匹配当前套餐 / 产品线。参考同类竞品（CCode）的默认端点配置是快速定位手段——它已被生产验证。
>
> 呼应 #004：本次"普通端点会报 429"初版写成断言，自查后发现是未核查的因果，已改为"待验证"措辞——**写因果断言和写数值一样要核查出处**。

### 关联

- 参考：CCode `D:\Study\CCode\cCli\src\config\config-manager.ts:53`（GLM 默认 coding 端点）
- 实现：[M2-方案解析 §Provider baseURL Q&A](../M2-方案解析.md)、`src/providers/config.ts` `resolveBaseURL`
- 方法论：#004（LLM 知识失真——因果断言同属核查红线）

---

## #007 Session ID 秒级精度碰撞——同秒两次运行产生重复会话文件

**日期**：2026-08-05
**影响**：`.ecode/sessions/` 里同一 session ID 出现多个不同 task 的文件，`loadSession` 只能找到第一个（随机），数据静默丢失。

### 现象

`.ecode/sessions/` 下 102 个文件，但只有 46 个唯一 session ID。38 个 ID 各有 2 个文件：

```
20260804082236_打招呼.json     ← task="打招呼", msgs=1, rounds=1
20260804082236_读-package.json.json ← task="读 package.json", msgs=5, rounds=2
```

同一 ID，不同 task → 不同 slug → 不同文件路径 → 覆盖写失效，两个文件共存。

### 根因

`agent.ts` 的 `timestampId()` 用 `YYYYMMDDHHmmss`（秒级精度）生成 session ID。同一秒内运行两次不同命令（快速连续执行 `npm run dev`），两次产生**完全相同的 ID**。

`saveSession` 的文件路径是 `{id}_{slug}.json`，slug 来自 `session.task`。同 ID + 不同 task = 不同文件路径 → 覆盖机制失效（设计假设"同 ID = 同 task = 同文件"）。

### 其他项目怎么做的

| 项目 | Session ID 方案 | 碰撞风险 | 出处 |
|------|----------------|---------|------|
| **Claude Code** | `crypto.randomUUID()` (UUID v4) | 10⁻¹⁸（不可能） | session 文件名 `{uuid}.jsonl`，内部 `sessionId` 字段也是 UUID |
| **OpenCode** | 内部 `createNext()` 自生成，`ses_` 前缀 | 不可能（随机 + 前缀） | issue #12916 / #5381 讨论，支持自定义 ID |
| **ECode (旧)** | `YYYYMMDDHHmmss` 时间戳 | **同秒碰撞** ❌ | `agent.ts:49-56` |

**共识**：所有成熟产品都用**随机 ID**（UUID / nanoid），不用时间戳。

### 解决

1. **`agent.ts`**：`timestampId()` → `generateSessionId()`，使用 `randomUUID()`（Node 18 内置 `node:crypto`，零依赖）。

```ts
import { randomUUID } from 'node:crypto';
function generateSessionId(): string { return randomUUID(); }
```

2. **`session.ts`**：`saveSession` 增加碰撞防御——检测到同 ID 前缀但不同 slug 时 `console.warn` + 清理旧文件 + 覆盖（防御性编程，UUID 后不可能触发，但日志留痕）。

3. **`runtime-logger.ts`**：新增 `logSessionSave()`，每次落盘记录 `filePath + id + task + msgs + rounds` 到 runtime-log。以后排查文件重复/丢失问题时不用猜，看日志就行。

### 教训

> **时间戳做 ID 只在"毫秒级精度 + 单进程 + 低频"前提下安全。** 秒级精度在快速连续执行（测试脚本 / 快速重跑）下必然碰撞。任何需要唯一 ID 的场景，直接用 `crypto.randomUUID()`（Node 18+ 零依赖），不要自己造轮子。
>
> **"同一 ID 应该只对应一个文件"的假设需要碰撞检测兜底。** 文件路径包含业务字段（如 task slug）时，ID 碰撞不会报错而是静默产生多文件。加一行检测 + 清理就能把静默数据丢失变成可感知的告警。

### 关联

- 实现：`src/agent.ts` `generateSessionId`、`src/session.ts` `saveSession` 碰撞检测、`src/runtime-logger.ts` `logSessionSave`
- 测试：`tests/session.test.ts` 新增碰撞检测用例（同 id 不同 task → 清理旧文件 + 覆盖）

---

## #008 关键路径缺日志 = 排查盲区——全功能日志覆盖原则

**日期**：2026-08-05
**性质**：工程实践（由 #007 排查困难触发）
**影响**：#007 的 session 文件重复问题，因为没有落盘日志，花了大量时间才定位到"同秒碰撞"这个简单根因。

### 现象

排查 #007 时，runtime-log 里只有 API 请求/响应和工具执行的日志，**没有 session 落盘的任何记录**。不知道：
- 什么时候落的盘
- 落到了哪个文件
- 用的是什么 ID 和 task
- 哪次落盘产生了重复文件

只能靠猜 + 手动翻目录 + 对比文件内容 + 读源码倒推，排查路径长且不确定。

### 根因

`persistSession` 是 fire-and-forget，只在失败时 `logError`。成功落盘**零日志**。加上 `saveSession` 本身也是静默写文件，没有任何输出——等于关键状态变更完全不可观测。

### 原则：所有功能的关键路径必须有日志

**什么算关键路径**（必须记）：

| 类别 | 示例 | 必须/建议 |
|------|------|----------|
| **状态变更** | session 创建/落盘/压缩、模型切换、配置加载 | 必须 |
| **外部交互** | API 请求/响应、工具执行、文件读写 | 必须 |
| **错误/异常** | 重试、降级、熔断、碰撞检测告警 | 必须 |
| **分支决策** | 压缩阈值命中哪级、exit-window 触发、权限裁决 | 建议 |
| **高频循环内部** | 每 100ms 的 spinner 帧、每字符的流式输出 | 不记（噪声） |

**日志怎么写**：

1. **关键状态变更**（session/配置/模型）：写入 `runtime-logger`（结构化、持久化、每行带时间戳）。
2. **错误/异常**：`logError(source, err)`（已有）。
3. **碰撞/异常状态**（防御性检测触发的告警）：`console.warn`（用户可见）+ `logError`（runtime-log 留痕）**双通道**。
4. **调试信息**（开发期帮助定位问题）：写入 runtime-log，不用 `console.log`（避免污染用户终端）。

**日志内容规范**：

- 必须包含**足够复现/定位的关键参数**（ID、路径、状态值、计数），不能只写"操作完成"。
- 参考 #007 的 `logSessionSave`：`filePath + id + task + msgs + rounds`——出问题看一行就知道是哪次、哪个文件。

### 对照检查（当前覆盖率）

| 模块 | API 日志 | 工具日志 | Session 日志 | 错误日志 | 缺失 |
|------|---------|---------|------------|---------|------|
| agent loop | ✅ logApiRequest/Response | ✅ logToolExecution | ✅ logSessionSave (本次补) | ✅ logError | — |
| context-manager | — | — | — | ✅ logError | 压缩决策点缺日志 |
| providers | — | — | — | ✅ logError | 端点选择/重试缺日志 |
| slash-commands | — | — | — | — | 命令解析/执行缺日志 |
| permission | — | — | — | — | 裁决结果缺日志 |
| REPL (ui/app) | — | — | — | — | 模式选择/命令 dispatch 缺日志 |

### 教训

> **"跑起来没报错"≠"出问题能查到"。** 排查靠的是日志，不是猜。关键路径没有日志 = 排查盲区 = 出问题只能靠读源码倒推。
>
> **写功能时同步写日志。** 不要"先实现再补日志"——事后补容易漏，而且补的日志往往不够（因为当时没意识到哪些参数重要）。每实现一个功能，顺手把关键路径的日志写上，成本几乎为零（一行 `appendFileSync`），收益是排查时间从小时级降到分钟级。
>
> **日志写什么比怎么写更重要。** 出问题时需要知道的是"哪次操作、什么参数、写到哪了"，不是"某时某分某秒做了什么事"。日志行里带全关键参数，一行就够了。

### 关联

- 触发原因：#007（session 落盘零日志，排查耗时远超修复耗时）
- 当前日志实现：`src/runtime-logger.ts`（`initRuntimeLog` / `logApiRequest` / `logApiResponse` / `logToolExecution` / `logError` / `logSessionSave` / `finalizeRuntimeLog`）
- 待补日志的模块：`context-manager.ts`（压缩决策）、`providers/`（端点选择）、`ui/app.tsx`（REPL 交互）
