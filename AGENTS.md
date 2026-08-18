# AGENTS.md — ECode 工作区指令

> **ECode**：终端 Agent CLI，AgentLoop 为心脏，其余能力（工具/模型接入/TUI/斜杠命令/历史/配置/日志）作为分支接入心脏。技术栈 TypeScript 严格模式 / Node.js，TUI 用 Ink，LLM 走 `@anthropic-ai/sdk` 接 Astron 兼容端点（跑 GLM）。
> **当前状态**：M1（心脏）+ M2（TUI 最小 Static）+ M3（工具集+ConfirmPrompt+bash 安全+.ecodeignore）+ M4（HistoryStore/向导/双协议 Provider）+ M5（上下文压缩：投影分离+分批 map-reduce 800k→200k 58s+cache 四维成本）+ M6（Skill 双触发面+MCP 按需加载+面板+内置 ecode-config 手册）+ M7（HookRunner 六事件+Plugin 安装链+PluginPanel）+ **M8（交互与上下文智能：ECODE.md 两级注入+截断可配/ask_user 选项框/auto-memory/WebFetch+SSRF/分段化/债清账+方案外交付：告警中心/面板+ /doctor 自检）全部完成**（2026-08-16 实施，852/852+两轮审阅修复；流式 markdown 彻底放弃 M8-D12）。**M9（安全网与质量闭环：hooks 接线修复 P0/checkpoint+`/rewind`（content-addressed 快照+区间跳过投影）/lint-test 回喂熔断/git 轻量（autoCommit+`/undo` trailer 校验）/沙箱四档+Tab 专职热键+blockedCommands/权限系统首步 Hook(owner) 三态三层/LSP 接口位）全部完成**（2026-08-16 实施，952/952+偏差与问题清单，`2026-08-15_后续-M9实施方案_已完成.md` 文末实施记录）→ **M10 = 感知扩展与配置可视化**（**全部完成** 2026-08-17 实施+终审修复+复审修复 1011/1011：多模态输入 ImageBlock+**PDF document block**（v1.2 扩入）：read_file 路径引用+双协议翻译 / 图片粘贴 P2 可选（Win/macOS）/ WebSearch 免费优先三层（搜索 MCP 优先→cn.bing RSS 零配置默认（唯一免费引擎，DDG 彻底放弃）→智谱可选；图片链路照做但**解析不兜底**（守卫只说"切模型或装图像 MCP"，不默认引导 GLM-4.6V-Flash/本地模型），v1.8） / /config 应用内面板：三页签+jsonc 非破坏修改+$EDITOR 逃生口 / 后台子进程任务 P3（v1.3 扩入：run_in_background+task_output/task_stop+统一杀树，顺带修 bash 单点 kill 孙进程泄漏）/ §9 滚动待办排期（M11 TUI 债候选——动态区高度预算系列 2026-08-18 拍板暂不执行），`2026-08-16_后续-M10实施方案_已完成.md` 文末实施记录）。**M11（Subagent+Todo+插话）全部完成**（2026-08-18 实施 P0-P7+实施记录，1043/1043：task 工具内嵌 runLoop 并发子代理（裁剪禁配 task/ask_user/todo+独立压缩链/独立 QualityGate/confirm 串行队列/transcript 独立+agentId 日志隔离/stop 谎报防御顺带修）+ todo 全量替换消息即状态+主循环插话（pollUserInput 步间注入+轮末兜底/Ctrl+U/F2 入队过 hook/图片标签免费随行），方案 v1.4（角色审阅修 F1-F4）（task 工具内嵌 runLoop 心脏零改动/并发直上 readonly 并行池/禁配 task+ask_user+todo/transcript 独立/日志 agentId/顺带修 stop 谎报；v1 经核码审阅修 3 P0——confirm 串行队列防死锁/独立压缩链防超窗炸父/makeTaskTool 工厂注入通路——+6 P1；**v1.2 扩入 todo 任务清单工具**（2026-08-18 用户拍板：builtin 静态+全量替换+readonly/消息即状态免 Store（rewind·恢复一致性免费）/transcript 内联 ASCII 状态符/子代理禁配取 opencode 紧口径）；**v1.3 扩入主循环插话**（2026-08-18 用户拍板：忙碌态输入激活+Enter 排队/双时点投递（loop pollUserInput 步间注入主路径+轮末兜底）/Ctrl+C 中断不弃队列（CC 同款）/Ctrl+U 清空/给子代理插话仍不做——跑完即返不变），`2026-08-17_后续-M11-Subagent实施方案_已完成.md` 文末实施记录+v1.4 变更记录，调研 `解析/2026-08-17_Subagent机制调研_已完成.md`）。 → **M12 = 服务化与多端已立调研**（2026-08-18 三路并行调研落档 `解析/2026-08-18_M12服务化与多端调研_已完成.md`：token 多维统计（CC stats-cache 增量模式）+ ecode serve 服务化（独立入口内嵌 node:http 与 TUI 互斥，opencode 同款）+ Web 对话页（REST+SSE+React19，快=coalesce+16ms 帧+Markdown 增量投影）+ 手机响应式优先 + IM 拍板：微信个人号不做（封号）、飞书/企微滑 M13；范围建议 M12=A+B+C+D、M12-Q1~Q8 决策点待用户拍板后立实施方案）。
> **永远使用中文与我对话。**
>
> 改代码/文档前先读这份。权威设计见 `docs/详设/2026-08-11_ECode-MVP详设_待审核.md`，文档体系以 `docs/README.md` 为权威。

---

## 一、通用原则 (Universal Principles)

### 1.1 设计哲学

- **极简导向**：少即是美，如无必要勿增实体 (KISS & YAGNI)。
- **性能平衡**：不追求极致优化，但拒绝显而易见的性能陷阱（如循环查库、N+1 查询）。
- **防御式编程**：优先"卫语句 (Guard Clauses)"尽早返回，拒绝深层嵌套（最多 3 层）。
- **关注点分离**：每个模块/函数只做一件事，高内聚低耦合。
- **配置与依赖方向**：能代码运行时自探测的，就别让用户/终端/外部环境去配置。别把「能不能正常工作」寄托在你管不了的外部环境（环境变量注入、终端行为、用户手动配 env）上——外部依赖越多，静默失效的链路越长、越难排查。自探测自洽（self-contained）、零配置、失败可优雅降级。

### 1.2 通用编码规范

- **命名**：变量/函数用业务语义命名，禁止无意义缩写（循环索引 `i/j/k` 除外）。
- **异常处理**：禁止吞掉异常，禁止空 catch/except 块；异常信息必须包含上下文。
- **魔法值**：禁止裸数字/字符串散落在代码中，提取为常量或枚举。
- **注释**：解释 Why 而非 What；复杂业务逻辑必须写注释，完整的功能模块要写清楚注释，显而易见的代码不写。

### 1.3 通用模式应用

- **策略模式**：`if-else > 3` 或复杂状态判断 → 重构为策略映射 (Map/Object)。
- **责任链/中间件**：多级校验、数据清洗场景优先使用。
- **Builder 模式**：参数 > 4 个的对象构建推荐使用。

### 1.4 任务执行流程

- **前置规划**：先规划（业务拆解 → 技术选型 → 流程梳理 → 方案输出）再编码。
- **后置总结**：任务完成后输出总结（实现思路、决策依据、优化点），除非用户明确不需要。
- **设计优先级**：需求优先聚焦接口设计（定义、入参出参、交互逻辑），数据存储设计后置。
- **错误处理**：解决同一个问题，第一次没解决掉，从第二次重复解决开始就上网查资料，不要一直试错浪费时间和 token。

### 1.5 职业视角与决策维度

- **架构师**：技术选型合理性、扩展性、长期演进。
- **资深开发**：代码可读性、执行效率、落地成本、最佳实践。
- **产品经理**：业务价值、时间成本、可行性。
- **底线**：成本可控、时间可预期、交付质量有保障。

### 1.6 文档管理

- **ECode 文档体系以 [`docs/README.md`](docs/README.md) 为权威**：6 目录（大纲/详设/解析/诊断/决策/规范）+ 文件名 `YYYY-MM-DD_[MVP-|后续-]中文名_状态.md` + ADR 编号。任何冲突一律以它为准，**不另立第二套命名/组织规则**。
- **权威设计文档**：`docs/详设/2026-08-11_ECode-MVP详设_待审核.md`（改核心模块前先读对应章节）；评审记录在 `docs/解析/`。
- 里程碑文档按需在 `docs/` 对应目录补充，**不预先占位**（YAGNI）。
- 一次性/临时文档命名 `YYYYMMDDHHMMSS_标题`；原理答疑并入对应里程碑的解析文档，**不另建 notes**。
- 设计文档更新时同步改引用（重命名/删除要全量 grep 改链接，避免断链）。
- **重要技术/架构决策记入 `docs/决策/` 的 ADR**（只追加不改，要改开新 ADR 标 `supersedes`），**不另建 `docs/memory/`**。
- **活文档同步**：改功能前查 [`docs/规范/2026-08-16_活文档清单与同步守则_已完成.md`](docs/规范/2026-08-16_活文档清单与同步守则_已完成.md)——17 处活文档（提示词/模板/人读文档）的同步触发表；工具指引有防漂移测试锁定，其余靠清单与 /doctor 兜底。
- 不要每次都写文档，除非用户明确提出或任务复杂度确实需要。

---

## 二、Node.js / TypeScript 领域 (ECode 技术栈)

### 2.1 语言与工程基线

- **TypeScript 严格模式**：`strict: true`，禁止 `any`（实在不得已用 `unknown`），`noImplicitAny` / `strictNullChecks` 必开。
- **依赖锁主版本**（`^`），避免 SDK 大版本变化（如 `messages.stream` API、事件名）导致断裂。
- **直接跑源码**：用 `tsx` 运行 TS、`vitest` 测试，不引入构建中间态。
- **模块**：ESM 优先（`import/export`），与 Node 现代规范对齐。

### 2.2 异步与并发

- **异步优先** `async/await`；**Loop 循环 / 请求热路径禁同步阻塞**（如 `readFileSync`），启动期配置加载可用同步读取。
- **流式接口用 `AsyncIterable` / `AsyncIterator`**（本项目 LLM 的 Delta 流即此形态），消费方 `for await` 驱动。
- **工具并行二分**：只读工具 `Promise.all` 并行，副作用工具串行（对应 Tool 的 `readonly` 元数据）。
- **长任务必须可中断**：透传 `AbortSignal` 给流式请求与工具执行，中断后用 `try/finally` 固化已产出内容。

### 2.3 错误处理

> 继承 1.2 通用异常规范，Node 侧补充：

- **统一错误对象**（`code` / `message` / `context` / `recoverable` / `retryable`），禁止裸 `throw` 字符串。
- **二分契约**：`recoverable` → 转 `tool_result(is_error:true)` 交上层（LLM）自纠；`fatal` → 抛顶层中断。
- 网络 / 超时 / 限流（429）走指数退避重试，而非直接 fatal。
- **固化逻辑放 `finally`**：正常 / 异常 / 中断三条路径都要把已生成数据落盘，避免中断丢内容。

### 2.4 校验与契约（心脏铁律）

- **入参校验用 AJV**（JSON Schema 原生，零转换，直接喂 LLM 协议格式）；MVP 不引 Zod 作定义层。
- **规范模型集中**在 `core/types.ts`，全系统只认这一套；各家协议差异封在各 Provider 实现内部（翻译职责）。
- **铁律**：心脏（AgentLoop）永不出现 `if provider === 'xxx'` 这类判断——协议差异一旦钻进心脏，抽象就泄漏了。

### 2.5 跨平台（开发与首要运行环境：Windows / Git Bash）

- **路径**：统一用 `node:path`（`path.join` / `path.resolve`），内部表示一律正斜杠；用户目录用 `os.homedir()`，**不依赖** shell 的 `~` / `$HOME` 展开。
- **shell / bash 工具**：显式依赖 Git Bash（`SHELL` 缺省回退 `bash.exe`，常见路径 `C:\Program Files\Git\bin\bash.exe`）；非 Windows 平台用系统 shell。代码按 `process.platform` 探测分流，**不写死**。
- **glob 模式用正斜杠**（跨平台通用），不用反斜杠；`fast-glob` 在 Windows 默认大小写不敏感，按需设 `caseSensitiveMatch`。
- **换行**：新增文件用 `\n`，读写工具默认保留原文件换行。
- **WSL**：ECode 当前是单进程 CLI，不涉及 Windows/WSL 双进程；若未来引入 WSL 侧组件（如 MCP 子进程）导致跨侧共享数据，见 5.3。

### 2.6 项目结构约定

- `src` 按职责分层：`cli`（入口）/ `core`（心脏：loop / types / errors）/ `providers`（模型接入）/ `tools`（工具）/ `commands`（斜杠命令）/ `services`（config / history / logger / logstore / redact / permissions）/ `tui`（Ink）。
- `tests/` 镜像 `src` 结构。
- 加新工具 / 新模型 = 写实现 + `register()`，心脏零改动（两个 Registry 是可插拔分支面）。
- **TUI 用 Ink（React for terminal）**：遵循函数组件 + Hooks 范式，`useEffect` 依赖数组完整声明，列表给稳定 `key`，组件 Props 定义 interface。

### 2.7 日志与可观测

- **全系统唯一写入入口**（`LogStore.emit`），禁止散落 `console.log`。
- **JSONL 结构化**，统一字段 schema（`ts` / `level` / `category` / `event` / `sessionId` / `iterNum` / `payload`）。
- **异步批量 flush**（100 条或 500ms），`fatal` 抛出前同步 flush，崩溃不丢关键日志。
- **脱敏集中**在 `services/redact.ts`（密钥模式 / 整字段），Logger 与 HistoryStore 共用同一规则，避免规则分叉。
- **LogStore ≠ HistoryStore**：前者是运行 trace（调试用，**不进 context**），后者是对话 messages（喂 LLM、`/history` 恢复），靠 `sessionId` 关联。

### 2.8 测试（TDD）

- **框架统一 vitest**，测试目录 `tests/` 镜像 `src`，命名 `xxx.test.ts`，运行 `npx vitest`。
- **Red → Green → Refactor**：先写失败测试 → 最小实现通过 → 重构优化；每个功能点先定义"完成条件"再转测试用例。
- **优先写单测的场景**：规范模型翻译（固定协议事件 → `Delta`）、Registry 注册 / AJV 校验通过&失败、流式 JSON 拼接、错误分类判定（`toAppError` 的 `recoverable`）。
- **集成测试**用 MockProvider（吐预设 `Delta` 序列）驱动 Loop，断言 messages 演进 / 工具调用顺序 / 停止条件，不发真实网络。
- 每个测试只验证一个行为；Mock 外部依赖（HTTP / 文件系统），不 Mock 被测对象自身；测试数据就近构造，禁共享可变状态。

---

## 三、大型复杂任务分解

### 3.1 分解原则

- **自顶向下**：先全局再局部，避免一头扎进细节。
- **交付粒度**：每个子任务必须有可验证的交付物（能跑的代码 / 能调的接口 / 能看的界面）。
- **依赖最小化**：子任务解耦可并行，有依赖的明确标注先后顺序。
- **单任务时间盒**：30 分钟~2 小时可完成，超过则继续拆。

### 3.2 何时启动正式分解

满足任一即启动（否则直接走 2.8 TDD）：

- 涉及 3 个以上模块/服务协作变更；
- 预估开发时间 > 4 小时；
- 需求描述模糊，需要先做方案对齐；
- 多端/多进程联调。

### 3.3 分解流程

需求澄清（明确 Done 定义）→ 架构草案（模块划分 + 接口契约）→ 任务拆解（带 P0/P1/P2 优先级 + 依赖 + 预估耗时）→ 逐个击破（每个子任务走 2.8 TDD + 阶段验证）→ 集成收尾（联调 + 端到端 + 完成总结）。

> ECode 的 M1-M4 里程碑（见详设第 10 节）本身就是顶层任务分解，子任务在此基础上细化。

---

## 四、协作备忘

- **先看方案再写代码**，动手前先给出思路。
- 遇到模糊需求主动追问，不自行假设关键业务逻辑。
- 代码变更最小化影响面，改动前评估关联影响。
- Git 提交信息遵循 Conventional Commits：`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`。
- **提交时机**：完成一个完整功能 / 修复完一个完整问题 / 小版本里程碑达成后再提交，**禁止每改一行就 commit**。中间调试小调整保留工作树，调通验证通过后一起提交。
- **commit 里不要出现任何 claude 相关内容**（尤其是 `Co-Authored-By: Claude`）。

---

## 五、环境与避坑约定

### 5.1 依赖与包管理

- **统一 npm**，禁用 pnpm / cnpm / yarn。依赖锁主版本（`^`），避免 SDK 大版本变化导致断裂。
- **换源 / 换网络环境前先删 `package-lock.json`**：lock 锁了旧源地址，切换后出误导性网络错误（如 `Exit handler never called!`），实际是源不可达。
- **跨 Windows/WSL 共享 node_modules 的原生二进制会失败**（缺对侧平台原生包）——在运行侧装依赖、跑构建，另一侧只做 `tsc` 类型检查。
- **npm 发布形态**：开发 `npm run dev`（tsx 跑源码 + 读 `.env`）；发布前 `tsc` 编译到 `dist/`，`bin` 指向 `dist/cli/index.js`（shebang `#!/usr/bin/env node`），`prepublishOnly` 自动 build，`npm publish` 发 `dist`。开发用 tsx、发布编译，两者不矛盾。

### 5.2 敏感信息

- 返回值含密钥 / 凭证的配置，**禁止透传到前端 / 打进日志**，统一走脱敏接口（如 `getMaskedConfig()`）。
- `.env` 及含密钥的运行时产物必须 gitignore（ECode 已忽略 `.env`、`.env.*`、`.ecode/`、`*.session.json`，`.env.example` 保留入库）。
- 密钥优先从环境变量读，其次 `~/.ecode/config.json` 的 `apiKey`（明文落盘 → 文件权限 600 + 日志脱敏）；**禁止硬编码**。

### 5.3 WSL ↔ Windows 混合环境（未来引入 WSL 组件时适用）

> ECode 当前是单进程 CLI，多数场景撞不到本节。**若未来引入 WSL 侧组件**（如 MCP 子进程），构建跑 Windows、Node 跑 WSL 时再参考：

- 两边 `os.homedir()` 是**不同物理目录**，不要散用 `os.homedir()` / `~` / `$HOME` 定位共享数据目录，统一走单一入口（优先级：显式 > env > 自探测对端 home > 默认）。
- **别用 WSLENV 桥接数据目录**（Windows Terminal 启动 wsl.exe 时进程级 WSLENV 覆盖注册表 User 级），改用代码自探测（`cmd.exe /c echo %USERPROFILE%` + `wslpath` 转路径，模块级缓存）。
- 原则：**运行时自探测 > 外部环境注入**（呼应 1.1 配置与依赖方向）。

### 5.4 进程与终端

- `spawn` / 终端 `start` 是 **fire-and-forget**，无法事后注入消息；`Failed to fetch` 类错误先查目标进程日志，别先怪网络。

---

## 六、开发者提醒

### 6.1 本地可参考源码和优秀项目
- 在本寻找一下优秀开源项目的源码避免在网上只能看到只言片语,部分靠猜测不可靠.如D:\study文件夹下有opencode,openclaw,codex,aider等项目的源码.