# CC 与 ECode 对话界面对比分析

> 日期：2026-08-28 · 产出：Claude（只读分析，未改任何源码文件）
> 对象：Claude Code 终端界面（以实际界面 + 官方文档为基准） vs ECode（D:/study/ECode，Ink TUI）
> 源码依据：`src/tui/TuiApp.tsx`、`App.tsx`、`Conversation.tsx`、`InputStream.tsx`、`TextInput.tsx`、`StatusBar.tsx`、`ShortcutHint.tsx`、`ActivityBar.tsx`、`ToolGroupView.tsx`、`ConfirmPrompt.tsx`、`toolview.ts`、`viewport.ts`、`UserMessage.tsx`、`AssistantMessage.tsx`、`symbols.ts`

---

## 一、ECode 对话界面布局结构（源码梳理）

整体是 **「Static 历史区 + 动态区」两区模型**（`Conversation.tsx`），自上而下：

```
┌─ banner（可选，配置无效时 round 边框黄字 ⚠，App.tsx:84-88）
├─ <Static> 已固化历史（滚轮友好，只增不改）
│    ├─ user        蓝底背景块 + ❯ 蓝前缀 + 亮色文字（UserMessage.tsx）
│    ├─ assistant   Markdown 全量渲染（AssistantMessage.tsx → Markdown.tsx）
│    ├─ tool-group  收起态固化：● N 个工具 names +▸ preview 单行（ToolGroupView）
│    ├─ compacted   ⇕ 已压缩（N 条已摘要进上下文，原文仍显示）
│    └─ rewind      ⇺ 已回退至快照点 N（其后对话不进上下文，原文仍显示）
├─ 动态区（当前轮，顶层有 viewport 行数总预算 allocateDynamic）
│    ├─ ① 折叠用户输入（≤2 行，P1-A 防粘贴撑爆）
│    ├─ ② ToolGroupView（折叠恒 ≤4 行；Ctrl+O 全展开；副作用工具轮末自动展开 diff）
│    ├─ ③ 流式灰字 GrayStreaming（tail 折叠）或轮末 Markdown / ConfirmPrompt 二选一
│    ├─ ActivityBar（braille 乒乓 spinner：思考中/执行中/重试中；idle 占位空行）
│    ├─ SubagentBar / TasksBar（条件渲染，各 ≤3 行，预算显式扣减）
│    ├─ 插话队列预览（「已排队：xxx（Ctrl+U 清空）」dimColor）
│    ├─ ErrorBanner / 各类 overlay（model-picker、history、setup、mcp、plugin、
│    │   question-panel、output-panel、rewind、sandbox、config、warnings、select）
│    ├─ systemMsgs（命令反馈，dimColor，不进对话历史）
│    └─ InputStream（❯ + 反色 caret + placeholder；下方 / 补全窗口 6 条）
└─ 底行：StatusBar（ECode · model · 轮 N/M · tok · MCP x/y · 沙箱 · 成本）
        + ShortcutHint（⏎ 发送 · Ctrl+J 换行 · / 命令 · ↑↓ 历史 · Ctrl+C 退出）
        + 第二行运行时告警（error 红/warn 黄/info 蓝，长消息截断）
```

关键设计决策（源码注释中明确记录的）：

| 决策 | 出处 |
|---|---|
| 轮末即 commit 进 Static（V4），空闲态动态区清零永不超屏 | TuiApp.tsx:380-394 |
| 视口预算统一模块：budget = rows − 2（Windows conhost 恰满屏触发 Ink 全清 scrollback，ink #969） | viewport.ts:17-34 |
| 动态区顶层一次分配（各段独立截断不保证总和 < rows） | viewport.ts:74-88 |
| 历史工具组默认全收起（用户拍板），全文回看归 /output 查看器 | Conversation.tsx:67-69 |
| 用户消息靠背景块区分、文字保持亮色（注释明确写「调研 Claude Code UserPromptMessage」） | UserMessage.tsx:6 |
| 输入粘贴折叠：头 5 行 + 折叠指示 + caret 行（注释写「CC +N lines 同款形态」） | TextInput.tsx:62-70 |
| / 补全两段式回填（回车=回填 `/name `，再回车才执行，所见即所发） | InputStream.tsx:100-106 |
| Tab 专职沙箱模式循环（非补全态拦截） | InputStream.tsx:199-207 |
| ConfirmPrompt preview 按终端行数截断（edit_file 大 diff 无数据层上限，此处是唯一防线） | ConfirmPrompt.tsx:22-27 |

---

## 二、Claude Code 界面基准

> 标注约定：【官方】= code.claude.com/docs 明确记载；【实测】= 常见实测行为，官方文档未描述。

**整体形态**：classic 渲染器下对话写入终端原生 scrollback（滚轮/Cmd+F 原生可用）+ 底部固定输入区；fullscreen 模式（`/tui fullscreen`）为 alternate screen，输入框固定底部、消息区可滚动。核心视觉词汇：用户消息 `>` 前缀、工具行 `⏺` 圆点、助手消息无前缀、thinking 灰斜体（【实测】）。

各维度细节见下节对比表。

---

## 三、逐维度对比清单

### 3.1 输入区（主布局块一）

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 位置 | 底部固定（fullscreen 明确写 input box stays fixed at bottom）【官方】 | 动态区末端（ActivityBar/系统消息之后），始终在最底 【源码事实】 | 等价 |
| 形态 | 多行编辑器；换行五方式：`\`+Enter / Option+Enter / Shift+Enter / Ctrl+J / 粘贴 【官方】 | 多行；换行三键位：Shift+Enter / Alt+Enter / Ctrl+J（注释明确写 legacy 终端 Shift+Enter 与 Enter 同字节不可区分，跨端稳妥组合） | ECode 已对齐 CC 子集；CC 的 `\`+Enter 前缀换行是终端无关兜底，**可低成本补** |
| 提示符 | `>` 或 `❯`（实测） | `❯`（symbols.ts，配 user 色彩） | 等价 |
| placeholder | 无常驻 placeholder；右下角 "? for shortcuts" 【官方】 | 有：空闲「输入消息，/help 查看命令...」/ 忙碌「（处理中，Ctrl+C 中断）...」，且忙碌判据用运行态镜像（注释记录了旧判据 streamingText 延迟 commit 导致「中断观感」的根因） | ECode 更进一步——placeholder 承载了上下文状态 |
| 快捷键提示行 | footer hints：esc to interrupt / ? for shortcuts / hold space to speak 【官方】 | ShortcutHint 两态：default「⏎ 发送 · Ctrl+J 换行 · / 命令 · ↑↓ 历史 · Ctrl+C 退出」/ busy「Ctrl+C 中断」 | 等价；CC 的 `?` 交互式快捷键面板更完整，ECode 只有静态一行 |
| 前缀快速输入 | `/` 命令+skill 菜单（可过滤）、`!` shell 直通、`@` 文件补全、`:` emoji 【官方】 | `/` 补全窗口（6 条窗口化 + ↑↓ 选中 + 两段式回填，命令+skill 合并、遮蔽标记） | **缺 `!` shell 直通与 `@` 文件补全**——`@` 补全对大仓库提效明显，`!` 免切终端跑一次性命令，均为可借鉴点 |
| 图片粘贴 | Ctrl+V/Cmd+V/Alt+V，插入 `[Image #N]` chip 于光标 【官方】 | Alt+V 读剪贴板，插入 `[图片#N]` 标签（标签即引用、删标签=删图；注释明确写「两家同款内嵌形态」+ 渲染闭包竞态用 ref 权威源修复） | 已对齐（含 CC 同款剪枝语义）；Ctrl+V 在 raw mode 是 0x16 不可用，ECode 注释有实证 |
| 历史导航 | Up 跨会话回溯（按工作目录存储）【官方】；Ctrl+R 反向搜索（fullscreen 下可切 scope）【官方】 | ↑↓ 会话内历史（InputStream 内存态，不持久） | **ECode 缺持久化命令历史与搜索**——按 cwd 持久化 + Ctrl+R 搜索是明确差距 |
| 粘贴大文本 | +N lines pasted 折叠指示（实测） | 头 5 物理行 + 折叠指示 + caret 行亮出（注释写「CC 同款形态」，且 V2 升级为物理行折叠治超长单行） | 等价，ECode 的 caret 行亮出是超出项 |
| 外部编辑 | Ctrl+G 用 $EDITOR 编辑 prompt 【官方】 | 无 | 可选借鉴，低优先 |
| 草稿 | Ctrl+S 暂存 prompt 草稿 【官方】 | 无 | 低优先 |

### 3.2 消息流排版（主布局块二）

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 用户/助手区分 | 用户 `>` 前缀+粗体、助手无前缀（实测）；会话头 cwd+分支 box（实测） | 用户：背景块 + ❯ + 亮色文字（源码注释明确「调研 CC 靠背景区分」）；助手：Markdown 直接排 | 等价；**缺会话头 box**（cwd+分支一次性信息，/clear 后重开会话时定位感有用） |
| Markdown | 列表/代码块/粗体，/theme Ctrl+T 开关代码高亮 【官方】 | Markdown 全量渲染（mdparse）；流式期是灰字 tail 折叠，轮末 commit 后才全量渲染 | ECode 的「流式灰字 → 轮末重渲染」两态有明确的视口预算动机（防超屏），但也牺牲了流式期富文本观感——CC 流式期即有轻量排版（实测），**可考虑流式期轻 Markdown（代码块/粗体）+轮末全量** |
| 压缩标记 | "Conversation compacted" 消息 【官方】 | `⇕ 已压缩（上方 N 条已摘要进上下文，原文仍显示）` 独立标记行，且 UI/模型上下文投影分离 | **ECode 更优**：投影分离（原文显示、上下文截断）语义比 CC 一行消息更准确； rewind 标记 `⇺` 同理 |
| token/上下文提示 | /context 实时分类占用、context 低位警告、statusline 可显 used_percentage 【官方】 | 状态栏累计 tok；切模型时超窗口 banner 提示（checkModelWindow） | CC 的**百分比化上下文余量**（"context left until auto-compact: 34%"类提示）比裸 tok 数更可感知，可借鉴 |
| thinking | Alt+T 切 extended thinking；灰斜体展示（实测） | 无独立 thinking 展示位（thinking 与正文混在流式灰字里） | **缺 thinking 通道可视化**——即使模型不输出独立 thinking 块，「思考中」spinner 之外的长静默期没有可展示内容 |
| prompt suggestions | 首开灰色示例命令（取自 git 历史）【官方】 | WelcomeScreen（未深读，存在该文件） | 大致等价 |

### 3.3 工具调用展示（主布局块三）

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 默认形态 | 摘要/一行式：npm test 只见 "Running npm test..." 与通过数；文件读取只显示 "Read auth.ts" 【官方】 | 收起态：`● N 个工具 names +N个` 表头 + 每工具 `name digest ▸ preview首行…(NB)` + `✓/✗` 状态符 | 等价理念（都默认折叠）；ECode 的**组级聚合表头**（N 个工具一行起）比 CC 逐工具一行更省行数，这在 24 行终端是净优 |
| MCP 工具 | 默认折叠单行 "Called slack 3 times"，Ctrl+O transcript 展开 【官方】 | 与普通工具同组展示（digest 取 path/command/pattern） | ECode 无按 server 聚合的专门形态，但 MCP 工具占比低时无碍 |
| 展开交互 | ctrl+e / 点击折叠项切换展开，"tool call and its result expand together"，仅有多余内容的可点 【官方】；`+N more lines`（实测） | Ctrl+O 当前轮全展开/全收起（组级开关，非单工具）；展开输出 head-tail ≤12 行；全文走 /output 查看器（50 条环形缓冲 + item/read 异步补全） | **差异最大的一格**：CC 是逐项展开（点哪个开哪个），ECode 是全有或全无。ECode 的取舍注释有记录（展开态每组 expandCap+2 行总高失控→收 1 组）。**可借鉴：单工具级展开**（↑↓ 选中 + Ctrl+O 只展开选中项），代价是要引入组内焦点概念 |
| diff 展示 | 红绿行内联（实测） | DiffLine 按行着色：- 红 / + 绿 / @@ 蓝 / --- +++ 加粗；edit_file/write_file 轮末自动展开（副作用工具特例） | 等价；**副作用工具轮末自动展开 diff 是 ECode 明确优项**（CC 需手动展开看刚改了什么） |
| 输出截断策略 | 摘要化（1,200 tokens 输出 → 一行）【官方】 | 数据级物理行折叠（先 wrap 后切窗，head-tail/尾窗两模式），配合全局预算 | ECode 的视口预算体系（viewport.ts 单一公式收敛）是系统性方案，CC 文档未披露等价机制——**这是 ECode 可反哺的方向**（Windows conhost/ink #969 的坑 ECode 已踩平并文档化） |
| todo 展示 | Ctrl+T 切换，最多 5 项，跨 compact 持久 【官方】 | todo 工具特化渲染：digest 显示 `N/M 完成`，展开态逐项 `[x]/[->]/[ ]` ASCII 状态符（注释：ambiguous 宽度教训只用 ASCII） | 等价思路；CC 的**独立面板 + 键位开关**比 ECode 的「内嵌在工具组里」更易一眼看到 |

### 3.4 权限档位与审批交互

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 档位体系 | 六档：default(Manual)/acceptEdits/plan/auto/dontAsk/bypassPermissions 【官方】 | 三档沙箱：default（写/bash 每次确认）/ read-only / workspace-write / full-access（nextSandboxMode 循环，Tab 切换；full-access 提档走宿主 Broker 审批帧） | 概念对位：ECode 沙箱 ≈ CC 权限档位。**CC 的 plan 档（只读规划）与 acceptEdits（自动接受编辑）在 ECode 无对位**——acceptEdits 对 ECode 的 edit_file 每次确认是高频打断点，**plan 档则是低成本的差异化补充**，均可借鉴 |
| 档位切换 | Shift+Tab 循环（Windows 无 VT 输入时 Alt+M）【官方】 | Tab 循环（M9-D13 专职，非补全态拦截） | 键位不同但等价；CC 让 Shift+Tab 给档位、Tab 留给补全，**ECode 反过来把 Tab 给了档位、/ 补全用回车两段式**——自洽，但与 CC 用户肌肉记忆相反，换档成本需权衡 |
| 审批 UI | options 列表 + Left/Right 切 tab + Up/Down 选 + Esc=No + Tab 打开注释字段（批准/拒绝附一句话）【官方】 | ConfirmPrompt round 边框卡：⚠ 执行 tool? + target + diff 着色 preview（行数感知截断）+ `[y]执行/[n]取消/[a]记住` ←→ 循环 + y/n 快捷键 | ECode 形态完整；**CC 的「审批附注释」字段是 ECode 没有的表达通道**（拒绝时告诉模型为什么），对减少反复试错有实效，可借鉴 |
| 记忆粒度 | "Yes, and don't ask again"：Bash/域名类永久存 settings.local.json，文件编辑类仅会话级 【官方】 | [a] 记住：MCP=本会话记住 server 级 / 权限类=永久写 settings.local.json（rememberLabel 双语义） | 等价；CC **按工具类别区分记忆持久度**的显式规则比 ECode 的双语义标签更不易误解 |
| 命令风险提示 | Bash 提示上 Ctrl+E 显示 Low/Med/High 风险解释 【官方】 | 无（bash 显示完整命令灰字） | 可借鉴（低优先——命令全文已可见，风险分级是锦上添花） |
| 多端审批 | — | approval/claimed：另一端认领时本端不撤弹窗 + 告警留痕（M14-C2⑤） | **ECode 独有**（宿主 Broker 多端架构），CC 无此场景 |

### 3.5 底部状态栏

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 基础信息 | 内置 footer：模型名 + mode 指示（"⏵⏵ accept edits on"）+ esc to interrupt（实测+官方部分）；model/cwd/分支/花费/**上下文百分比**/rate limits 得靠自定义 statusline 脚本（statusline 数据字段官方列了全套）【官方】 | 内置一行全量：ECode · model · 轮 N/M · tok · MCP x/y · 沙箱（full-access 危险色 ⚠）· 成本 | ECode 内置密度更高；CC 的**mode 指示（⏵⏵ accept edits on）**在 ECode 只体现为沙箱段文字，**档位可视化弱**——切了档没有醒目常驻标识，可借鉴箭头符档位指示 |
| 目录/分支 | 自定义脚本才有 | 无 | ECode 缺（与会话头同源问题，见 3.2） |
| 成本/上下文 | cost.total_cost_usd / context_window.used_percentage 字段齐 【官方】 | 会话累计成本（¥，tokensToCost）+ 累计 tok；/cost 命令查本轮明细 | ECode 有但**无上下文余量百分比**（同 3.2） |
| 通知位 | 系统通知（MCP 错误/更新/context 低位）与 statusline 共享行右侧 【官方】 | 独立第二行 + 分级着色（error 红/warn 黄/info 蓝）+ /warnings 面板 + 底部单行派生 | **ECode 更优**：告警中心（队列+面板+单行派生）比 CC 单行共享位的承载力强 |
| statusline 扩展 | 官方脚本机制（cwd/PR 徽章/vim mode 等）【官方】 | 无插件化 statusline | 可选远期项 |

### 3.6 滚动与历史浏览

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 基础滚动 | classic：原生 scrollback（滚轮/Cmd+F）；fullscreen：PgUp/PgDn 半屏、Ctrl+Home/End、滚轮逐行 【官方】 | Static 进原生 scrollback（滚轮友好，源码注释明确此设计目标） | 等价（ECode 等价 CC classic 模式） |
| auto-follow | fullscreen 上滚暂停跟随 + "Jump to bottom (3 new messages)" 浮钮 【官方】 | 不适用（无 alternate screen） | ECode 无 fullscreen 模式；**视口预算体系本质上是用「动态区恒 ≤ rows」回避了该问题**——架构取舍不同，不算缺陷 |
| transcript 查看器 | Ctrl+O：详细工具执行 + 每条消息时间戳与模型 + less 式导航（/ 搜索、{ } 跳 prompt、g/G）+ `[` 写入 scrollback + `v` $EDITOR 【官方】 | Ctrl+O 被用作「当前轮工具展开/收起」；/output 查看器（最近 50 工具环形缓冲 + 任务日志 + 子代理 transcript，翻页 + 回车进全文） | **键位语义冲突的借鉴点**：ECode 的 Ctrl+O ≠ CC 的 Ctrl+O（transcript）。ECode /output 已覆盖「工具全文回看」但**缺对话级 transcript 浏览**（历史轮 assistant 全文在超预算时只显示降级提示行「再次输入后进入历史区可回看」）。**CC 的 `[`（把对话写入 scrollback 供原生搜索）是最便宜的补法**——一行 ANSI 输出即可 |
| 历史搜索 | Ctrl+R 反向搜索，可切 scope（会话/项目/全部）【官方】 | 无（输入历史 ↑↓ 会话内、不持久） | 同 3.1，明确差距 |

### 3.7 其他对话界面元素

| 子维度 | Claude Code | ECode | 差距/借鉴点 |
|---|---|---|---|
| 中断 | Esc 停止响应保留已完成工作；有排队消息则立即发送 【官方】 | Ctrl+C 中断（useInterrupt + isActive 守卫：confirm/picker 期间不抢）；双击退出走优雅关闭 | 等价；CC 的「中断时若有排队消息立即全发」是 ECode 排队机制的补全语义（ECode 中断后队列靠注入时序），可对齐 |
| 双击 Esc | 有文本=清空存草稿；空=rewind 菜单（checkpoint 恢复代码+对话）【官方】 | /rewind 命令开 RewindPanel（快照点列表 + checkpoint.copyForResume 跨重启） | **功能等价但入口深**：CC 双击 Esc 是零成本入口，ECode 要输 /rewind。**「空输入框 + 快捷键直达 rewind」是高价值低成本借鉴**（ECode 的 rewind 机制本身已完整：投影分离、宿主权威、快照跟随） |
| 消息排队 | 工作时输入+Enter 排队，「lists queued entries above input box」；消息类在工具间隙同 turn 送入、命令类等 turn 结束；Up 取回排队项；Esc 中断立即全发 【官方】 | 插话队列：宿主 queue 权威 + 预览行「已排队：xxx（Ctrl+U 清空）」+ StartOrSteer 模式 + interjection/injected 事件清预览 | 等价（ECode 预览行位置与 CC 相同：输入框上方）；**Up 从输入框首行取回排队项**是 ECode 缺的精细操作 |
| 后台任务 | Ctrl+B 后台跑 Bash（tmux 按两次）【官方】 | TasksBar（任务条 + taskRegistry 1s 轮询 + /output 看任务日志） | 功能等价，CC 的**键位直达**（跑着的东西一键收进后台）比 ECode 的任务注册路径更顺手 |
| ask_user 类交互 | AskUserQuestion 工具（选项问题+Other） | QuestionPanel overlay（Promise 桥回工具 execute） | 等价 |
| 自动 compact | 接近上限自动触发、/autocompact 调阈值 【官方】 | 自动压缩（compacting/compactFailed 事件）+ /compact 手动 + 切模型超窗 banner 引导 | 等价 |
| 模型切换 | /model 【官方】 | /model → ModelPicker overlay（providers 笛卡尔积）+ 切换后 context 窗口检测 | ECode 多了**切模型超窗预检**（CC 无对位提示） |

---

## 四、总结：优先级排序的差距与可借鉴点

### 高价值（对话主布局直接补强）

1. **`@` 文件路径补全**（3.1）——输入区最大的功能性缺口。ECode 已有 / 补全的窗口化+两段式骨架，`@` 触发文件遍历补全是同构扩展，对大仓库提效立竿见影。
2. **输入历史持久化 + Ctrl+R 搜索**（3.1/3.6）——ECode 历史仅会话内存态。按 cwd 持久化（ECode 已有 HistoryStore 基础设施，加一个 input-history 文件即可）。
3. **单工具级展开**（3.3）——当前 Ctrl+O 是全有或全无。CC 的「点哪个开哪个」在多工具轮里是刚需；ECode 注释已记录总高失控的顾虑，可保留预算钳制、只加组内单选展开。
4. **对话级 transcript 写入 scrollback（CC 的 `[`）**（3.6）——ECode 超预算轮的 assistant 全文目前只有降级提示行。把 committed 全文重打一遍进 scrollback 是最便宜的全文回看补法，且与 ECode 的 Static 架构天然契合。

### 中价值（体验对齐）

5. **`!` shell 直通模式**（3.1）——`!` 前缀分流到本地 shell、输出入上下文；ECode 的 InputStream 分流点结构（命令→skill→未知）已留好位置。
6. **审批附注释字段**（3.4）——拒绝/批准时附一句话给模型，减少反复试错；ConfirmPrompt 加一个 Tab 进入的文本行。
7. **acceptEdits 档**（3.4）——「自动接受文件编辑、bash 仍确认」是 CC 高频档位；ECode 沙箱三档里 default→workspace-write 之间缺这个粒度（workspace-write 是否含 bash 免确认需查 services/sandbox.ts 语义）。
8. **档位可视化**（3.5）——状态栏沙箱段加 CC 式箭头指示（⏵⏵ accept edits on 形态），切换即时反馈。
9. **会话头 box**（3.2）——/clear、恢复会话后打一个 cwd+分支+时间的头框，定位感强，一次性输出无预算压力。
10. **双击 Esc 直达 rewind**（3.7）——ECode rewind 机制完整但入口深；空输入框+双击 Esc 零成本直达（注意与现有双击 Ctrl+C 退出的肌肉记忆区分开）。

### 低价值 / 远期

11. `\`+Enter 换行兜底、Ctrl+G 外部编辑器、Ctrl+S 草稿、Ctrl+R scope 切换、`:` emoji、命令风险分级（Ctrl+E）、statusline 脚本插件化、fullscreen 模式（ECode 的视口预算路线与 alternate screen 是二选一的架构取舍，不建议兼走）。

### ECode 已对齐或反超的点（不需动）

- 视口预算体系（viewport.ts 单一公式 + 物理行折叠 + 退化保护）——系统性解决了 Ink 全清 scrollback 问题，注释里踩坑记录完整，是 CC 文档未披露的隐性机制；
- 压缩/回退的**投影分离标记行**（⇕/⇺，原文显示、上下文截断）——语义比 CC 的一行消息准确；
- 副作用工具轮末自动展开 diff——CC 需手动展开；
- 告警中心（队列+分级+面板+单行派生）vs CC 单行通知位；
- 图片内嵌标签 `[图片#N]`（含剪枝语义与竞态修复）——与 CC 同款且踩平了 Windows raw mode 的坑；
- 多端审批认领（approval/claimed）——ECode 宿主架构独有；
- 组级工具聚合表头——24 行终端下比逐工具一行省。

---

## 五、方法说明与可信度边界

- ECode 侧结论全部来自本仓库源码当日快照（feat/m1-heart 分支），文件级引用见文首清单；标注「源码事实」的均为代码直接可见行为，含注释中记录的设计决策与踩坑史。
- CC 侧：标【官方】的条目出自 code.claude.com/docs（interactive-mode / permissions / statusline / fullscreen / context-window / permission-modes 六页）；标【实测】的视觉细节（⏺/❯/会话头 box/+N more lines 等）官方文档未记载，引用时已逐条标注，避免无出处质疑。
- 本分析为只读，未修改任何源码；唯一写入物即本文件。
