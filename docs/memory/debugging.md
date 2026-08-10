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

> **✅ 2026-08-07 二次复核：已接线**——`agent.ts:312` 实际调用 `forceCompact`（grep 命中），L3 响应式恢复**已落地**。下方「从未接线 / 零命中」为修复**前**快照，保留作历史脉络（也是 [[#010]] 文档滞后的活案例）。
>
> **⚠️ 2026-08-07 复核纠正（实读源码核实，非 LLM 推断）**
>
> 本文 §"ECode 实现"（L161）/ §"验证"（L174）声称「L3 响应式恢复已实现 + 全量测试通过」**部分失真**——下次会话**勿据此假设超限已能自恢复**：
> - **函数层确实实现且单测过**：`isContextWindowError`（context-manager.ts:353）、`forceCompact`（:376）、`maybeCompress`（:316）都在；tests/context-resilience.test.ts 20 测试覆盖它们**作为纯函数**。
> - **但 agent.ts 从未接线**：`grep 'forceCompact\|isContextWindowError' src/agent.ts` 零命中。catch 块（agent.ts:459-480）只处理 `AbortError`，其余异常（含 API 400 context-window 错）一律 `yield {type:'error'}` 终止 loop，**无 forceCompact 恢复重试分支**。
> - 即「函数级绿、集成级红」——本文 §"现象"描述的死局**实际未解决**：超限后 agent 仍会死。`withRetry`（retry.ts:33）把 400 当不可重试直接抛，加重死局。
> - 下次修 M3 时接线 catch 块（修法见 [../总纲/ECode项目审查报告.md](../总纲/ECode项目审查报告.md) 🔴-1），并补「provider 首次抛 context_length_exceeded → forceCompact 恢复重试」的回归测试（现有 agent-stream.test.ts 只覆盖 maybeCompress **主动**压缩，未覆盖**响应式**恢复）。

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
- [M3-方案解析 §五](../里程碑/M3-方案解析[已完成].md) 踩坑预警（本文补充其 §5.5 未覆盖的"API 报超限后恢复"）

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
- 实现：[M2-方案解析 §Provider baseURL Q&A](../里程碑/M2-方案解析[已完成].md)、`src/providers/config.ts` `resolveBaseURL`
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

---

## #009 ink `<Static>` 是 append-only——切换/清空会话后历史不刷新

**日期**：2026-08-06
**影响**：`/resume` 切换会话（或 `/clear`）后，`<Static>` 区只追加新项，**旧 index 位的历史不刷新**——表现为「切到新会话，上一会话的旧消息还赖着」「clear 后第一条新消息出现在旧消息下面」。

### 现象

C 方向 `/resume` 切换会话测试，`switchSession` 用新会话历史**替换** `completedMessages` 后，末帧只见 `历史回答`（index 1）出现，`历史提问`（index 0）**没渲染**。

### 根因

ink 的 `<Static items={...}>` 语义是 **append-only 一次性写 stdout**：

- 它**记录已写出的 item index 数量**（不是内容）。
- items 数组**整体替换**时，`<Static>` 只认「index ≥ 上次写出数量」的项为新项去追加；**旧 index 位不重新 diff、不重新渲染**。
- 「替换整个数组」对它不是「清空重画」，而是「在已有项后面接着加」。所以 `completedMessages` 从 `[A,B]` 换成 `[C,D]`，它不会画 C/D——因为 index 0/1「已经写过」。

这是性能优化（O(n)→O(1)，每条只写一次不 diff）的代价：**它假定 items 是单调增长的日志流**，不支持「整个数组换掉」。

### 解决：用 key 强制重 mount

加一个 `staticKey: number` 到 `StreamState`，在**任何替换 completedMessages 的地方**自增，用作 `<Static key>`:

```tsx
// use-agent-stream.ts：switchSession / clear 里
setState((prev) => ({ ...prev, completedMessages: history, staticKey: prev.staticKey + 1 }));

// chat-view.tsx：key 变 → <Static> 卸载重 mount → 视为全新流，全量重灌历史
<Static key={state.staticKey} items={state.completedMessages}>
```

key 一变，React 卸载旧 `<Static>`、挂载全新的 → 内部「已写出 index」计数归零 → 把当前 items 当全新流全量渲染一次。**这是让 `<Static>` 支持数组替换的唯一干净手段**（比 `useEffect` 手动操作 stdout/`Static` 命令式 API 都简单可靠）。

真实终端再叠加清屏（`process.stdout.write('\x1b[2J\x1b[H')`)，把上一会话写过的 stdout 物理擦掉，视觉彻底干净（测试 `!isTTY` 不执行，不影响断言）。

### 教训

> **`<Static>` 不是受控列表渲染器，是一条单向追加的日志管道。** 它优化掉了 diff，代价就是「整体替换数组」对它无效。凡是要「换一批」item（切会话 / 清空 / 还原历史 / 回放），都不能指望改 items——必须换 `<Static>` 的 `key` 让它重 mount。记住这条，ink 里凡是"数据整体换掉但 UI 没跟着换"，第一反应就是 `<Static>` 的 append-only。

### 验证

`tests/ui/repl-human.test.tsx` 加了 3 个防假绿用例：① 过滤当前会话（断言当前 task 不在列表）；② Enter 切换后历史可见（断言`历史提问`/`历史回答`都在末帧——直接覆盖本坑）；③ 续接 `resumed.id` 正确。其中②就是为这个坑准备的回归测试。破坏 `switchSession` 里的 `staticKey++` 后②立刻变红，证实非平凡。全量 40 文件 335 测试绿，tsc clean。

### 关联

- 实现位置：`src/ui/types.ts`（`staticKey` 字段）、`src/ui/use-agent-stream.ts`（`switchSession`/`clear` 自增）、`src/ui/chat-view.tsx`（`<Static key>`）、`src/ui/app.tsx`（`handleResumeConfirm` 清屏）
- 触发场景：C 方向 `/resume`（详设 `docs/详设/20260806210000_历史会话切换-详设.md` §八 预见了此风险，本坑是其落地）

---

## #010 文档 `file:line` 随代码漂移 + 文档状态滞后于实现——易腐数据红线

**日期**：2026-08-07
**性质**：文档维护（方法论），跨项目通用
**影响**：功能架构设计[进行中].md 三角色审阅时发现两类失真——① 行号错（🔴-1 写 `agent.ts:459` 实际 `:312`、🔴-2 写 `:379` 实际 `:412`）；② 状态错（[[#005]] 复核段写「forceCompact 从未接线」，实读 `:312` 早已接线）。读者按行号跳转找错位置、按状态断言误判"做没做"。

### 根因

- **行号是易腐数据**：代码增删一行，下方行号全位移；文档 `file:line` 不会自动跟随，停留在写文档时的快照。
- **文档状态滞后于实现**：实现推进后文档不复查，标"待补"的可能早做了（🔴-1）、标"已完成/未接线"的可能已变（[[#005]]）。**文档状态 ≠ 实现状态**是反复踩的坑。

### 解决

1. **行号当快照不当锚点**：文档 `file:line` 加日期注（`agent.ts:312 @2026-08-07`）让读者知时效；永久引用优先用**符号名**（"forceCompact 调用处"比 ":312" 稳）。
2. **进新里程碑前核查**：grep 核对关键 `file:line` + 实读源码核实 P0/🔴 状态断言（本次审阅就这么发现 459→312、379→412、#005 反转的）。
3. **状态断言同属核查红线**（呼应 [[#004]]）：写"已实现/未接线/待补"和写"具体数值"一样，要么核查要么标注时效。

### 教训

> **行号是易腐数据，文档里当快照用、注明时效；永久引用优先用符号名。更要警惕"文档说待补/已完成"与代码实际脱节——进新里程碑前扫一遍"文档状态 vs 代码实际"，避免基于过时文档决策**（如以为某 P0 没修不敢进下阶段，或以为某功能就绪其实没接线）。

### 关联

- 同类：[[#004]]（LLM 知识数值失真）、[[#005]]（文档"未接线"实际已接线——本文档滞后活案例，本条即由其触发）
- 触发场景：功能架构设计[进行中].md 三角色审阅，核查 `src/agent.ts` 行号发现漂移

---

## #011 Windows：Edit/Write 工具写 CRLF，仓库 LF → git diff 全替换污染历史

**日期**：2026-08-07
**性质**：开发环境 / 工程基础设施（跨任务反复踩）
**影响**：C 组提交前发现 `git diff --stat` 显示 `transform.ts 532 行 / claude.ts 245 行`（≈2× 文件行数），实际语义改动仅 17/2。直接提交会把整个文件标记为「全删全加」，diff 噪声淹没真实改动、污染历史、阻碍 code review。

### 现象

- `git diff --stat` 某文件改动行数 ≈ 2× 文件总行数（如 types.ts 116 行显示 245 改动）。
- `git diff` 里整块 `-foo` / `+foo`（同内容却标记改了）。
- `git diff --ignore-all-space`（或 `--ignore-cr-at-eol`）瞬间缩到真实改动量（如 17/2）→ 确认是空白/行尾差异。

### 根因

- **Edit/Write 工具在 Windows 上把文件写成 CRLF（`\r\n`），仓库历史是 LF（`\n`）**。
- 项目 `core.autocrlf=false` + **无 `.gitattributes`** → git 不自动 normalize，工作树 CRLF 与 HEAD LF 每行都判不同 → 全替换视图。
- `grep -c $'\r'` **检测不可靠**（bash 转义/按行分割问题），曾显示 `0` 但文件实含 `\r`——**判断行尾用 `od -c`，不用 grep**。

### 判断方法（看到异常大 diff 时）

```bash
# 1. 看真实改动量（忽略空白）——若缩到正常，确认是行尾
git diff --stat --ignore-all-space src/providers/types.ts
# 2. od 看字节真相（\r\n = CRLF，\n = LF）——不靠 grep
head -2 src/providers/types.ts | od -c | head -4
git cat-file -p HEAD:src/providers/types.ts | head -2 | od -c | head -4
```

### 解决

**临时 SOP（每次提交前）**：对本次 Edit/Write 改动的文件 sed 转 LF：
```bash
for f in <改动的文件...>; do sed -i 's/\r$//' "$f"; done
# 转后 git diff --stat 应回到真实改动量（几十行而非几百行）
```
（C 组提交前已用此法把 589→ 真实改动，commit `1fed920` 干净。）

**根治建议（待用户决策）**：加 `.gitattributes` 统一行尾策略——
```
* text=auto eol=lf
*.ts text eol=lf
*.tsx text eol=lf
*.md text eol=lf
```
再加 `git add --renormalize .` 一次性把全仓库 normalize 到 LF。这是 git 官方推荐做法，但会触发全仓库文件行尾重写（一个大批次 commit），**属项目级决策，需用户确认后执行**。

### 教训

> **Windows 开发 + git，行尾策略必须显式声明（`.gitattributes`），不能依赖工具默认。** 否则编辑器/AI 工具写 CRLF、CI/Linux 假定 LF，每次提交都全替换。判断行尾用 `od -c` 看字节，不用 `grep $'\r'`（不可靠）。AI 工具（Edit/Write）在 Windows 默认产 CRLF，提交前必须 sed 转 LF，否则 diff 全替换、历史污染。
>
> **诊断信号**：`git diff --stat` 改动行数 ≈ 2× 文件行数 = 八成是行尾翻转，立刻 `--ignore-all-space` 验证。

### 关联

- 触发：C 组（P5 errors/usage）提交前发现 diff 异常
- 影响：D/E 组后续每次 Edit/Write 都会踩——**提交前必须 sed 转换改动文件**（已成 SOP）
- 同类环境坑：[[#002]]（`env -i` 清 TMPDIR）、CLAUDE.md §9.3（WSL↔Windows 混合环境）

---

## #012 Windows bash 三连坑：同步阻塞 + find.exe + GBK 乱码

**日期**：2026-08-08
**影响**：agent 运行时 UI 卡死 / 命令报错 / 输出乱码 / 死循环误触发——四个连锁问题

### 现象（runtime-log 030028 实证）

1. **UI 卡死**：loader 消失，程序无响应（execSync 阻塞主线程，ink spinner setInterval 冻结）
2. **bash find 报错**：`find tests -name "*.test.ts"` → Windows find.exe 输出 `拒绝访问` / `找不到文件`（不是 Unix find）
3. **输出乱码**：cmd.exe 默认 GBK 代码页，UTF-8 终端显示 `╧┘─╧` 之类乱码
4. **死循环误触发**：vitest 全量测试超 30s 被 execSync 卡死 → agent 重试相同命令 → 签名一致 → 误判死循环

### 根因

四个问题共享一个根因链：**execSync + Windows 默认 shell（cmd.exe）+ LLM 不知平台生成 Unix 命令**。

| 问题 | 根因 |
|------|------|
| UI 卡死 | execSync 同步阻塞 Node 事件循环 → ink 无法刷新 spinner |
| find 报错 | LLM 生成 `find tests -name ...` → 命中 Windows 内置 find.exe（不是 Unix find） |
| GBK 乱码 | cmd.exe 默认代码页 936(GBK)，UTF-8 终端无法正确解码 |
| 死循环误触发 | 30s 超时杀进程 → agent 重试同命令 → 死循环检测签名匹配 → 误判终止 |

### 解决

**四个问题一个方案**（`src/tools/bash.ts` 完整重写）：

1. **execSync → spawn 异步**：Promise + child_process.spawn，不阻塞事件循环 → UI 不卡
2. **Git Bash 自动探测**：`where bash.exe` + `\Git\` 过滤（避开 WSL 伪入口），有 → `bash -c`（POSIX）
3. **cmd 兜底 UTF-8**：无 Git Bash 时 `cmd /c "chcp 65001 >nul & command"`（强制 UTF-8 代码页）
4. **system-prompt 注入环境**：`src/system-prompt.ts` 注入 `Platform/Shell/Cwd`（Shell 与 executeBash 一致）
5. **超时 120s**：足够跑全量测试

**关键设计**：
- `getShellInfo()` 导出供 system-prompt，确保 LLM 看到的 Shell 与实际执行一致（有 Git Bash → LLM 用 ls/find；无 → LLM 用 dir/findstr）
- 不硬编码路径（git 可能在 `D:\Tool\Git` 而非 `C:\Program Files\Git`），用 `where` 探测

### 教训

> **Windows 上的 bash 工具不能直接 execSync + cmd.exe。** 必须异步（不卡 UI）+ POSIX shell 兜底（避 find.exe/GBK）+ 告知 LLM 实际 Shell（防 prompt 与执行错配）。三者缺一会连锁爆雷。
>
> 硬编码安装路径不可靠（用户自定义安装位置），用 `where` / `which` 探测。

### 关联

- 实现：`src/tools/bash.ts`（完整重写）、`src/system-prompt.ts`（ENVIRONMENT 段）
- 测试：`tests/bash.test.ts`（7 测试：Promise/echo/多行/尾部换行/错误/管道/stderr）
- 诊断证据：`docs/logs/runtime/2026-08-08/2026-08-08_030028.md`

---

## #013 ink 默认 `exitOnCtrlC:true` 让应用层 Ctrl+C 逻辑成死代码（+ testing 硬编码 false 造成测试盲区）

**日期**：2026-08-08
**性质**：框架默认值陷阱 / 测试盲区（TUI 层，跨项目通用）
**影响**：用户报告「Ctrl+C 一次就直接退出整个程序」，而设计要求是「单击中断对话、双击(2s 内)退出」。app.tsx 早就写好了正确的分工逻辑，但从没生效过。

### 现象

REPL 里按一次 Ctrl+C，整个进程立即退出。app.tsx 的「单击 `api.abort()` 中断流 + 双击 `process.exit(0)`」useInput 回调看上去完全正确，但**从未触发过**。

### 根因（实读 ink 源码，非推断）

ink 的 `render()` 默认 `exitOnCtrlC: true`（`node_modules/ink/build/render.js:14`）。此开关让 ink **在 useInput 之前的 stdin 层**就拦截 Ctrl+C：

- `ink/build/components/App.js:151`：`if (input === '\x03' && exitOnCtrlC)` → 直接走 `handleExit` → unmount + `process.exit`。
- `ink/build/hooks/use-input.js:104`：`if (input === 'c' && key.ctrl && internal_exitOnCtrlC) return` → 即便到了 useInput，也提前 return 不调应用回调。

两道闸门都在「应用 useInput 回调」之前。ECode 的 `src/index.ts` render 调用**从没传 `exitOnCtrlC: false`** → 用默认 `true` → `\x03` 在最外层被 ink 拦走退出 → **app.tsx 的 Ctrl+C 分工逻辑是死代码**。这就是「一次就退出」的原因。

### 测试为何抓不到（关键盲区）

`ink-testing-library` 在 `build/index.js:75` **硬编码 `exitOnCtrlC: false`**——跟真机的默认 `true` **不一致**：

| 环境 | exitOnCtrlC | `\x03` 去向 | app.tsx 分工逻辑 | 单测 |
|------|-------------|-----------|----------------|------|
| **ink-testing** | 硬编码 false | 流到 useInput | 一直生效 | 恒绿 |
| **真机**（修复前） | 默认 true | ink stdin 层拦走 | 死代码 | — |

测试环境一直让 `\x03` 能到 useInput，所以这块逻辑「测了就绿」，真机却被 ink 拦了。**测试与真机的默认开关不一致 = bug 长期潜伏**。

### 解决

1. **`src/index.ts`** render 加 `exitOnCtrlC: false`（一行），把 Ctrl+C 放给 app.tsx useInput 处理。真机与测试两端配置就此拉齐。
2. **补回归测试**（`tests/ui/app.test.tsx`）：双击 Ctrl+C(2s 内) → `process.exit(0)`；单击 Ctrl+C → 中断运行中流（出「— 已中断 —」）。守护 app.tsx 分工逻辑，防未来改坏。
   - 注：这两测试在 testing 环境（恒 false）跑，**无法复现真机 bug**——真机的「一次退出」只能手动冒烟验证。

### 教训

> **框架的「默认开关」类配置（尤其是会拦截 stdin / 改变进程退出行为的），必须显式核对默认值是否符合预期**——不能假设「我不传就用合理默认」。ink 默认 `exitOnCtrlC:true` 对普通 CLI 合理（该 Ctrl+C 退出），但对「要自定义 Ctrl+C 行为」的应用就是陷阱：默认值会让应用层逻辑变**死代码**，且代码看起来完全正确，极难发现。
>
> **配套盲区：测试库可能 hardcode 与真机不同的默认值。** ink-testing-library 硬编码 `exitOnCtrlC:false`，让单测里 Ctrl+C 一直能到应用回调 → 测试恒绿 → 真机坏的 bug 长期潜伏。诊断「逻辑写对了但从没生效」类问题，**优先怀疑框架在更外层（stdin/事件层）拦截/吞掉了输入**，并核对「测试环境的框架配置 == 真机配置」。

### 关联

- 实现：`src/index.ts`（render options `exitOnCtrlC:false`）、`src/ui/app.tsx` Ctrl+C 分工（原为死代码）
- 设计：[EscCtrlC 横向分工详设](../详设/20260807000318_EscCtrlC横向分工-详设[已完成].md)（单击中断 / 双击退出 / Esc 清空不中断）
- 同类「框架默认值 / 语义陷阱」：[[#001]]（Node `--env-file` 不覆盖既有 env）、[[#009]]（ink `<Static>` append-only 语义陷阱）

---

## #014 中断错误识别不能只靠 `instanceof DOMException`——SDK 包装的 abort 错误会漏判

**日期**：2026-08-08
**性质**：错误处理 / SDK 兼容（agent 层）
**影响**：Ctrl+C 中断后，UI 除了预期的「— 已中断 —」还多显示一行 `✗ Request was aborted.`（英文、重复）。修 [[#013]] 启用 app.tsx 中断逻辑后暴露。

### 现象

中断流程：app.tsx `api.abort()` → controller.abort() → fetch 被 abort → openai SDK 抛错。agent.ts 外层 catch 只识别 `err instanceof DOMException && err.name==='AbortError'`，但 SDK 抛的**不是** DOMException（message 形如 "Request was aborted"）→ 漏判 → 当真错误 `yield {type:'error', error:'Request was aborted'}` → UI 显示 `✗ Request was aborted.`。

### 根因

`instanceof DOMException` 是**类型判断**，依赖错误对象的精确类型。但中断错误在不同层形态不一：

| 来源 | 错误形态 | instanceof DOMException |
|------|---------|------------------------|
| Node 原生 fetch + AbortController | `DOMException { name:'AbortError' }` | ✅ 被识别 |
| **openai SDK 包装** | 普通 `Error`（message "Request was aborted"） | ❌ 漏判 |
| 其它 SDK / 运行时 | APIError / 自定义类型 | ❌ 漏判 |

用类型判断中断 = 把"是不是中断"押在"SDK 把错误包装成哪个类"上——换 SDK/运行时就漏。

### 解决（`src/agent.ts` catch）

改用**状态判断优先**：

```ts
const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
const aborted = opts.signal?.aborted || isAbortError(err);
```

- `signal.aborted` 最可靠：不管 SDK 包装成什么类型/message，只要 signal 已 abort 就是中断（**状态 > 类型**）。
- `isAbortError` 兜底：无 signal 场景（测试直接抛 AbortError）按 name/message 识别。

### 教训

> **判断"是不是中断/取消"用状态（`signal.aborted`）不用类型（`instanceof`）。** 中断错误在不同运行时/SDK 形态不一（DOMException / Error / APIError），`instanceof` 类型判断换层就漏。`signal.aborted` 是与错误形态解耦的状态，最可靠。
>
> **通用延伸**：判断"是不是某类错误"时，优先用**语义信号**（状态字段 / message 关键词 / 错误码），而非**类型**（instanceof）——后者把判断耦合到了具体错误类，跨 SDK/运行时易碎。

### 关联

- 同轮修复：[[#013]]（ink exitOnCtrlC 启用 app.tsx 中断逻辑后，本 bug 才暴露——此前 app.tsx 中断逻辑是死代码，根本走不到这里）
- 测试盲区同类：[[#003]]（现有中断测试 mock runAgent 主动 yield aborted completed，不抛错 → 测不到 SDK 抛非 DOMException 错误的路径；本条补了 provider.stream 抛 `Error` + `signal.aborted` 的回归测试）
- 实现：`src/agent.ts` catch 段、回归测试 `tests/agent-stream.test.ts`

---

## #015 M5 三源联网研究推翻多处早先假设——"不瞎想"的实证教训

**日期**：2026-08-08
**性质**：方法论（[[#004]] 的又一活案例），M5 设计阶段
**影响**：M5 三文档（子代理/MCP/Hooks）初稿凭"源码阅读 + LLM 知识"写了若干断言，联网核实官方规范后**多处被推翻**，若不核实就进 TDD 编码会走偏。

### 现象（被推翻的断言）

| # | 早先假设（错） | 联网核实（对） | 出处 |
|---|---------------|---------------|------|
| 1 | HTTP+SSE 在 `2025-11-25` 废弃 | **废弃自 `2025-03-26`**（`2025-11-25` 是引入带 session 的 Streamable HTTP，session 机制 `2026-07-28` 又移除） | [MCP Streamable HTTP spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) |
| 2 | Dynamic Client Registration（RFC 7591）当前可用 | 已于 `2026-07-28` **废弃**，由 Client ID Metadata Documents 取代 | MCP Changelog |
| 3 | "CSA Labs 推荐切 Streamable HTTP 更安全" | **不成立**——CSA Labs 页面 403 读不到；OX Security 推荐的是 SDK 级命令白名单/沙箱，**不是换传输** | OX Security / The Hacker News |
| 4 | CC hook 事件 ~27 个 + handler 只 command | 实际 **30+ 事件、5 种 handler**（command/http/mcp_tool/prompt/agent） | code.claude.com/docs/en/plugins-reference |
| 5 | PreToolUse 的 `permissionDecision` 放 JSON 顶层 | **必须嵌套在 `hookSpecificOutput` 下**，顶层平铺静默丢弃（CC #48760） | code.claude.com/docs/en/hooks |
| 6 | 子代理 frontmatter 主要 4 字段 | 实际 **17 字段**；且 **不存在 `glob` 字段**（访问控制走 tools/disallowedTools + hooks） | code.claude.com/docs/en/sub-agents |
| 7 | "CC 把 Agent 工具放进 disallow 列表 → 默认禁子代理嵌套" | **嵌套允许**，默认深度 3，Agent 工具在子代理默认可用（仅深度受限时移除） | code.claude.com/docs/en/sub-agents |

### 根因

- **源码阅读 ≠ 官方规范真相**：读 `coreTypes.ts` 统计出"27 事件"是源码枚举口径，官方文档是 30+；读 `constants/tools.ts` 以为"Agent 工具被禁"是没理解 disallow 列表的条件性（仅深度受限时生效）。
- **LLM 既有知识对"快速演进的协议/产品"必然失真**：MCP 规范半年内从 2025-03-26 → 2025-11-25 → 2026-07-28 三次大改，DCR 从支持到废弃，子代理 frontmatter 字段持续扩张——这类"快速变化的具体事实"是 LLM 知识的最弱区（呼应 [[#004]]）。
- **"研究核实"必须落到权威一手源**：CC/opencode 源码是"实现真相"，但官方文档是"产品真相"，两者口径可能漂移；MCP 规范站是"协议真相"。三者交叉，以**官方文档 + 规范站**为最终裁决。

### 解决（已在 M5 文档修正）

1. 三文档所有被推翻断言全部改为核实值（带 URL + 核实日期 2026-08-08）。
2. 每条加"🔴 核实纠偏"标注，保留"早先假设 vs 核实结论"对照——**不掩盖失真过程**，让读者知道哪些是易错点。
3. 不确定的一律标"⚠️ 待审阅/待用户拍板"（如子代理权限继承 A/B、MCP 配置 A/B），不强行下结论。

### 教训

> **"不要自己瞎想"= 三源交叉核实，且以官方文档/规范站为最终裁决。** 源码阅读能拿到"实现真相"，但官方文档是"产品真相"、规范站是"协议真相"，三者口径会漂移（源码枚举 vs 文档枚举、条件性 disallow vs 无条件）。写设计文档时：(1) 协议/规范类（MCP 版本、废弃时间、字段定义）查规范站；(2) 产品行为类（hook 事件、frontmatter 字段）查官方文档；(3) 实现细节类（file:line）查源码。三者冲突时标出分歧、以官方为准，不强行统一。
>
> **快演进的协议/产品（MCP/CC）半年内可能大改**——写"具体版本号/字段/废弃时间"这类断言时，LLM 知识的失真概率最高，必须联网核实时效。这正是用户要求"在网上查资料不要自己瞎想"的原因。

### 关联

- 同类方法论：[[#004]]（LLM 知识数值失真）、[[#010]]（文档 file:line 漂移 + 状态滞后）
- 产物：[M5-技术选型 §10-T2/T6/T7](../里程碑/M5-技术选型与理由[已完成].md) + [M5-方案解析 Q4/Q18/Q20](../里程碑/M5-方案解析[已完成].md)（均含🔴核实纠偏）

---

## #016 `npm test` 是 watch 模式（vitest 无 `run`）——全量测试挂着不退出

**日期**：2026-08-09
**性质**：工具配置坑（影响所有「跑全量测试」场景）
**影响**：在 Claude Code / CI / 脚本里跑 `npm test` 期望「跑完全套自动退出」，实际 vitest 进 watch 模式永久挂着，被误判为卡死/超时，被迫 kill。

### 现象
`npm test` 跑 5+ 分钟不结束，`TaskOutput` 一直 `running`，以为测试 hang 住。

### 根因
`package.json` 的 `"test": "vitest"`（无 `run`）→ vitest 默认 **watch 模式**，监听文件变化不退出。
`CLAUDE.md`「常用命令」表写 `npm test` = 全套测试，与实际 watch 语义矛盾（误导）。

### 解决
- **全量一次性**（跑完退出，CI/验证用）：`npx vitest run`
- **单文件**：`npx vitest run tests/xxx.test.ts`
- **watch**（开发时随改随跑）：`npm test`（或 `npx vitest`）

> 提示：`CLAUDE.md`「常用命令」表的 `npm test` 宜标注 watch，全量验证统一用 `npx vitest run`。

---

## #017 MCP 启用时内置工具被喂丢 → LLM 被迫用 MCP 工具做本地任务 → 瞎编参数死循环

**日期**：2026-08-10
**性质**：根因 bug（agent 工具注入层）+ 误判教训（先怪模型后查自己代码）
**影响**：多模态任务里 GLM-5.2 反复调 `mcp__zread__read_file`（瞎编 `dummy/repo`、`test/repo`），死循环出不来；最初误判为「GLM 工具选择固着 / 认知问题」。

### 现象（runtime-log 实证）

跑多模态详设任务，LLM 反复调用失败的 `mcp__zread__read_file`，参数是编造的 `dummy/repo`、`test/repo`。doom-loop 没拦住（LLM 每次变参数，规避了精确签名匹配）。`logApiRequest` 显示 `toolCount: 6`，但 `registry.ts` 有 11 个内置工具。

### 初始误判（走弯路）

最先归因为「GLM 工具选择固着 / 说了不用还用」，并往 system prompt 堆 POLICY（Task/MCP 使用规则）试图教 LLM 别滥用。**这是症状层补丁，没修根因。**

用户质疑「是不是我们的代码有问题 / 怎么让 GLM 返回正确参数别瞎编」，逼着深挖，才在 `use-agent-stream.ts` 找到真凶。

### 根因（三层）

1. **工具合并 bug**（`use-agent-stream.ts`）：MCP 启用时只传 MCP 工具——
   ```ts
   tools: mcpToolsRef.current.length > 0 ? [...mcpToolsRef.current] : undefined
   ```
   `agent.ts` 的 `baseTools = opts.tools ?? toolDefinitions` 因 `opts.tools` 非 undefined（MCP 数组非空）→ **丢弃内置 `toolDefinitions`**。LLM 根本看不到 `read_file`/`grep`/`glob`/`bash`。
   - smoking gun：`mcp/manager.ts:197 getAllTools()` 只返回 `[...pool.values()].flatMap(i => i.state.tools)` = **仅 MCP 工具，不含内置**。

2. **为什么 GLM 瞎编参数**：它没有本地 `read_file`，被逼用唯一的 MCP 工具（zread，设计用于读远程 GitHub repo）做本地任务 → zread 要远程 repo URL → 它编造 `dummy/repo`。**这不是 GLM 认知问题，是工具集喂错了**——换成 Claude 在同样错工具集下也会挣扎。

3. **doom-loop 为何没拦住**：doom-loop（`doom-loop.ts`，忠实移植自 opencode `processor.ts:356-380`）按精确 `(toolName, input)` 签名匹配计数。GLM 每次变垃圾参数（`dummy/repo`→`test/repo`）→ 签名不同 → 计数归零，永远到不了阈值 3。

### 解决（治本 + 兜底 + 精简，三层）

1. **治本**（`use-agent-stream.ts`）：合并内置 + MCP——
   ```ts
   tools: mcpToolsRef.current.length > 0 ? [...toolDefinitions, ...mcpToolsRef.current] : undefined
   ```
   LLM 看到正确工具集，自然用 `read_file` 做本地任务。**REPL 实测验证通过**（用户确认）。

2. **兜底**（`agent.ts`，Plan C 断路器）：MCP 工具连续失败 3 次会话内禁用。键用 `(toolName, isError)` 而非 `(toolName, input)`——防「变参数」规避。只对 `mcp__` 前缀生效（内置 bash/edit 失败是业务常态，禁了危险）。

3. **精简**（`system-prompt.ts`）：删 `SUBAGENT_POLICY` / `MCP_POLICY` 两条 prompt 规则。工具集喂对 + 各工具 description 自解释，LLM 自然做对；原 POLICY 是 bug 的症状层补丁。**代码层能修的绝不放到 prompt 层让 LLM「知道」**（CLAUDE.md §1.1 极简）。

### 教训

> **「模型行为异常」先查喂给它的工具集，别先怪模型。** `toolCount` 日志（实际 vs 内置数）是最快证据。CC/opencode 跑在 Claude 上没事，不是它们代码更好，是 Claude 在错工具集下也挣扎得更「优雅」——换成等价 bug 它们也会坏。本次若不是用户坚持「是不是我们代码的问题」，差点一直在 prompt 层打补丁。
>
> **兜底机制的键要考虑规避手段。** 精确 input 匹配（doom-loop）会被「变参数」绕过；按 `(toolName, isError)` 键（Plan C）对参数变化免疫。设计防滥用计数时，想清楚「被计数对象能不能改签名规避」。
>
> **治本 > prompt 补丁。** 看到 LLM 滥用某工具，第一反应不该是「在 system prompt 加规则教它别用」，而是「它为什么非用这个不可」——九成是它没别的可选（工具集/权限喂错）。代码层修根因，prompt 层只兜代码管不了的认知偏差。

### 关联

- 同类「先怪模型/环境后查自己」：[[#004]]（LLM 知识失真，那是真失真；本次是代码 bug 被误判成模型问题）
- 实现：`use-agent-stream.ts`（工具合并）、`agent.ts`（Plan C 断路器）、`system-prompt.ts`（删 POLICY）、`tools/subagent.ts`（Task description 补「别甩理解」）
- 参考：opencode `processor.ts:356-380`（doom-loop 移植源）、`mcp/manager.ts:197` getAllTools()（smoking gun）

---

## #018 模型名查询大小写敏感 → 用户 config 大写 key 被小写查询静默查不到

**日期**：2026-08-10
**性质**：配置健壮性（config 查询层）
**影响**：`agent-stream.test.ts:328 getContextWindow('glm-5.2')` 返回 128000（期望 1M）；真机隐患——上下文压缩阈值 = `contextWindow × 0.8`，查不到兜底 128K → 阈值算错（本该 800K 变成 102K），压缩时机错乱。

### 现象与根因

用户 `~/.ecode/config.json` 按厂商惯例写**大写** `GLM-5.2`（`defaultModel: GLM-5.2`），代码/测试各处查询用**小写** `glm-5.2`。`findModel`（config.ts:275）只做精确 key 匹配，大小写敏感 → 小写查询查不到大写 key → `getModelConfig` 抛「未知模型」→ `getContextWindow` catch 兜底 128000。

探测实证：`getContextWindow('glm-5.2')` = 128000，`getContextWindow('GLM-5.2')` = 1000000。

### 解决

`findModel` 改大小写不敏感（精确优先，降级 `toLowerCase`）：精确匹配先命中（避免大小写近似 key 歧义），没命中再遍历找 `toLowerCase` 相等的。模型名作标识符，大小写差异不应致查不到。

```ts
const exact = pc.models[modelId];        // 精确优先
if (exact) return { config: exact, providerKey: pk };
for (const [k, v] of Object.entries(pc.models)) {
  if (k.toLowerCase() === lower) return { config: v, providerKey: pk };  // 降级
}
```

### 教训

> **配置查询的标识符匹配要大小写容错。** 用户按厂商惯例写模型名（GLM/GPT 大写、deepseek 小写），代码里写小写，必然对不上——要么存储时归一化（全 lowercase），要么查询时容错。本次选查询容错（不改用户 config 写法，对厂商惯例友好）。判断：凡「用户手填 + 代码查询」的标识符（模型名 / provider 名 / 别名），都该大小写不敏感。

### 关联

- 实现：`providers/config.ts` findModel、`tests/providers/config.test.ts`（大小写不敏感回归测试 4 断言）

## #019 ECode REPL 退出后 MCP server 子进程残留累积（process.exit 跳过 React 异步 cleanup）

**日期**：2026-08-10
**性质**：资源泄漏 / 进程生命周期（MCP 连接池 × 退出路径）
**影响**：每开一次 ECode REPL，MCP server 子进程（npx→node 两层）退出后残留，后台 node 进程越堆越多（用户实测几十个）。

### 现象与根因

`McpManager.disconnectAll()`（杀子进程树：SDK close + win32 taskkill / POSIX pgrep BFS）只挂在 React `useEffect` cleanup（`use-agent-stream.ts:230`）。而 REPL 所有退出入口都走 `process.exit(0)`：
- `app.tsx` 双击 Ctrl+C
- `app.tsx` `/exit` 斜杠命令

`process.exit` 直接终止 Node，**跳过 React 异步 cleanup** → MCP 子进程无人杀 → 残留累积。CLI 模式（--list-models/--sessions/one-shot/--continue/usage）不加载 MCP，无此问题。

### 解决（统一退出 shutdown + 单例可达 + fast-path）

1. **McpManager 模块级单例**：`getMcpManager()` / `getMcpManagerOrNull()`（manager.ts）。原组件 ref（use-agent-stream）退出回调拿不到；单例让 app.tsx 跨组件树可达 `disconnectAll`。保留 `new McpManager(opts)` 供测试注入。
2. **`lifecycle.ts` shutdown(code)**：有活跃连接才 `await disconnectAll()`（race 3s 超时兜底，防 SDK close 卡死）→ `process.exit`；无连接（CLI / REPL 未连 MCP / 测试）走 **fast-path** 跳过 await，`process.exit` 同步触发。
3. **接线两处 REPL 退出**：`void shutdown(0)` 替代 `process.exit(0)`。
4. **use-agent-stream** 改用 `getMcpManager()`（指向单例）。

### 测试教训（async shutdown × 同步退出语义）

- **async 函数 fire-and-forget 把 process.exit 推到微任务**：`void shutdown(0)` 不 await；唯有 fast-path（无连接、无 await）才让 `process.exit` 同步触发。→ 加 `hasActiveConnections()` fast-path：无连接跳过 await 恢复同步语义。
- **async 函数 throw 不传播到 fire-and-forget 调用者**：双击 Ctrl+C 测试原用 `rejects.toThrow('EXIT')`（mock process.exit 抛错），但 async shutdown 抛错只让自身 promise reject，`void` 丢弃 → ctrlC() resolve 而非 reject。→ 改空实现 spy + 断言被调（语义等价：验证退出触发）。
- **repl-human 连真 MCP**：`simulate(<App>)` → connectAll 读**全局** `~/.ecode/mcp/registry.json`（resolveDataDir 默认 ~/.ecode，非 CWD），连真 server → pool 非空 → fast-path 不触发。之前被同步 process.exit 掩盖。→ mock `loadMcpRegistry` 返回 [] 隔离（测斜杠/快捷键本就不该依赖 MCP）。

### 多端覆盖

| 入口 | 处理 |
|------|------|
| REPL 双击 Ctrl+C / `/exit` | `shutdown(0)` → 有连接清理 → exit ✅ |
| CLI（--list-models/--sessions/one-shot/...） | 不加载 MCP，单例 null → no-op ✅ |
| 崩溃 / uncaughtException | 边缘未接（改崩溃行为有风险），后续按需 |
| Windows / POSIX | killProcessTree 已覆盖（taskkill /T /F + pgrep BFS）✅ |

### 关联

- 实现：`src/mcp/manager.ts`（单例 + hasActiveConnections）、`src/lifecycle.ts`（新）、`src/ui/app.tsx`（两处退出）、`src/ui/use-agent-stream.ts`（getMcpManager）
- 测试：`tests/lifecycle.test.ts`（4 用例含 fast-path）、`tests/mcp-manager.test.ts`（单例 3 用例）、`tests/ui/repl-human.test.tsx`（mock registry + 双击改 spy）

## #020 MCP 工具结果单行 JSON 转义串刷屏（foldContent 对「单行超长」内容截断失效）

**日期**：2026-08-10
**性质**：UI 渲染 / 工具结果展示（MCP content × foldContent 折叠策略）
**影响**：MCP server（web-search-prime / web-reader 等）把 `JSON.stringify(result)` 当单个 text 返回时，ECode 主界面把整行转义 JSON 串当 1 行刷出 = 用户看到的「乱码」。

### 现象与根因

MCP 工具结果经 `adapter.ts`（content 数组 text 拼接）→ `ToolResult.content` = 单行紧凑 JSON 字符串（无缩进、无换行）→ `tool-panel.tsx foldContent`：

- `split('\n')` 只得 **1 行**（整串无换行）；
- 所有 `mcp__*` 工具走 `DEFAULT_STRATEGY = head(3)`，但 head 截断前提是「行数 > 3」，1 行不触发；
- BlockTool 把整行超长转义串当 1 行渲染 → 刷屏乱码。

**关键洞察**：截断逻辑按「行数」计数，而紧凑 JSON 是「单行超长」——行数维度抓不到它。

### 解决（foldContent head/full 分支加 prettifyCompactJson）

`foldContent`（tool-panel.tsx）在 split 前对 head/full 分支做 `prettifyCompactJson(content)`：

- trim 后以 `{`/`[` 开头 + **不含换行**（单行紧凑）+ `JSON.parse` 成对象/数组 → `JSON.stringify(parsed, null, 2)` 缩进美化；
- 否则原样（纯文本 / 已多行 JSON / 以 `{` 开头的非合法 JSON / number/string）。

美化后变多行 → head(3) 截断 + "more lines" + Ctrl+O 展开重新生效。

### 为什么一处覆盖所有 MCP（统一性）

所有 `mcp__*` 工具走同一渲染链（chat-view → ToolDone → foldContent → DEFAULT head(3)），且都不进 `isMergeableTool` 合并组（只 read_file/grep/glob/bash 进）。故一个 `prettifyCompactJson` 统一覆盖：

- 返回 JSON 字符串的中招者（web-search / web-reader）→ 修好；
- 返回纯文本者（zread read_file 返回文件内容）→ detect 跳过，零影响。

### 边界（保守不误伤）

- **summary 模式（read_file/glob/ls）跳过美化**：只按原始行数计数，美化会让 "Read N lines" 的 N 失真；
- 已多行 JSON / 纯文本 / 非合法 JSON → parse 失败或含换行 → 原样返回；
- **LLM 侧零影响**：只改展示层 foldContent，不动 adapter 的 `ToolResult.content`，模型仍看原样 JSON 字符串能正常 parse。

### 关联

- 实现：`src/ui/tool-panel.tsx`（prettifyCompactJson + foldContent head/full 分支接入）
- 测试：`tests/ui/tool-panel.test.tsx`（7 新用例：单行 JSON 美化 / 数组 / 纯文本不变 / 已多行不重复 / summary 不美化 / 非合法 JSON 原样 / ToolDone 端到端）
- 提交：`040155f`

---

## #021 GLM-5.2 不支持 image_url content type → 400（多模态图片输入降级）

**日期**：2026-08-10
**性质**：API 兼容 / 模型能力差异
**影响**：用户附带图片输入时，GLM-5.2（纯文本模型）报 `400 messages.content.type 参数非法，取值范围 ['text']`，agent loop 第一轮即崩。

### 现象

用户在 REPL 输入图片路径（如 `解析 C:\...\xxx.png`），InputBar 正确提取路径、readImageFromFile 正确 base64 编码、transform.ts 正确转为 OpenAI 多模态格式 `{type:'image_url', image_url:{url:'data:image/png;base64,...'}}`——但 GLM coding plan 端点只接受 `type:'text'`，直接 400。

### 根因

**GLM-5.2 是纯文本模型，不支持 vision**。智谱的视觉能力在独立模型线上（GLM-4V-Plus / GLM-4.5V），用不同端点和模型名。ECode 没有检测模型能力就发了 image blocks。

### 解决（vision-fallback.ts 一次性降级）

不自动切模型（用户选的模型有意图），不帮 LLM 做代理决策（不检测 MCP）。只做：
1. `resolveImageStrategy(model, images)` 纯函数检测模型是否支持 vision
2. 支持 → inline（发 image blocks）
3. 不支持 → strip（移除图片数据，保留文本路径）+ 注入 llmHint 告知 LLM 完整情况
4. LLM 自己看工具列表决定怎么办（调 MCP 图片工具 / 告诉用户没办法）

**防无限调用**：决策是纯函数，一次性执行，不进 agent loop 迭代循环。

### 教训

> **模型能力差异是真实约束，不是所有 OpenAI 兼容端点都支持多模态。** coding plan 端点专为代码优化，不含 vision。config 里模型的 `capabilities` 字段必须如实声明，不能假设所有模型支持所有能力。

### 关联

- 实现：`src/vision-fallback.ts`、`src/agent.ts`（resolveImageStrategy 接入 + llmHint 注入 user message）
- 测试：`tests/vision-fallback.test.ts`（7 单测）
- 决策：不切模型理由见 [decisions.md #007](./decisions.md)

---

## #022 MAX_ITERATIONS=25 打满 → 任务被静默截断（agent loop 增强三件套）

**日期**：2026-08-10
**性质**：agent loop 健壮性（迭代预算管理）
**影响**：续接会话历史重（45+ messages）+ Windows 下全量测试命令反复失败（timeout/dev/stdin 不兼容），LLM 连续 5 轮白烧迭代，25 轮打满被强制终止。

### 根因（三层叠加）

1. **LLM 不知道自己快没轮数了**：agent loop 没有告知迭代预算，LLM 以为可以无限试错
2. **bash 连续失败不触发 doom-loop**：doom-loop 只检测完全相同的 (tool,input)，LLM 每次换命令变体（timeout→--reporter→/dev/stdin），绕过了检测
3. **MAX_ITERATIONS 硬编码不可配**：续接重会话时 25 轮不够用

### 解决（三件套）

1. **ToolFailureTracker 公共组件**（`src/tools/failure-tracker.ts`）：任意工具连续失败 N 次（参数可不同）→ 提醒 LLM 换策略。与 DoomLoopDetector（防死循环）、errorStreak（MCP 熔断）三者各司其职。
2. **MAX_ITERATIONS 可配置**：`config.json` 的 `agent.maxIterations` 驱动，默认 25。达上限后不静默截断，而是注入总结指令强制 LLM 诚实产出"已完成/未完成/后续建议"。
3. **callTool 超时保护**（`src/mcp/client.ts`）：MCP 工具调用经 raceWithTimeout 套 60s 超时（之前裸调无超时，慢 server 会让 agent 永久挂起）。

### 教训

> **agent loop 必须有迭代预算管理——不只是上限，还要让 LLM 感知到约束。** LLM 不知道自己在烧轮数就会盲目试错。三个检测器各司其职：DoomLoop 防精确重复、FailureTracker 防变参数连续失败、errorStreak 熔断 MCP 不可信代码。

### 关联

- 实现：`src/tools/failure-tracker.ts`、`src/agent.ts`（接入 + 达上限诚实总结）、`src/providers/config.ts`（agent.maxIterations）、`src/mcp/client.ts`（callTool 60s 超时）
- 测试：`tests/failure-tracker.test.ts`（13 单测）、`tests/mcp-client.test.ts`（+4 callTool 超时）
