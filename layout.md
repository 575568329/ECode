# TUI 排版批任务书：布局/段落缩进学习 Claude Code（用户反馈「目前的排布有点乱」）

用户原话：「ecode 中 tui 的显示布局，段落的缩进排布是不是可以学习一下 claude，目前的排布是不是有点乱」。本批=对比 CC 排版→产出差距清单→实施改进。

## 第一步：对比调研（先做，产出差距清单后再动手）

输入：`docs/解析/2026-08-28_CC与ECode对话界面对比_已完成.md`（界面维度基准）+ `D:\study\claude-code-main` 源码。逐维度对比 CC 与 ECode 的：

1. **段落缩进体系**：CC 各内容块的左缩进层级（用户消息/assistant 文本/工具行/工具输出/引用块/列表）；ECode 现状各是多少、是否不一致（「乱」的根源往往是有的是 0 缩进有的是 2 有的是 4）；
2. **块间距节奏**：块与块之间的空行规律（CC 是不是统一的段落间距）；ECode 现状哪些块贴着哪些块隔两行；
3. **视觉层级**：颜色/粗细/暗色的层次使用（标题/正文/元信息的区分度）；
4. **对齐**：工具行的图标+名称+参数对齐方式；多行内容（工具输出/列表）的悬挂缩进（hanging indent）；
5. **宽度利用**：正文宽度控制（CC 是否限宽）、长 URL/长路径的断行策略。

产出：差距清单写入本文件追加节（每条：CC 做法（带源码锚点）/ECode 现状（截图帧描述+代码锚点）/差距评级），**先汇报清单再实施**（监看方过目后开工——本回复只到清单，等「继续」）。

## 差距清单（第一步产出）

> CC 锚点 = `D:\study\claude-code-main`，ECode 锚点 = `D:/study/ECode`。评级：🔴 结构性差距 / 🟡 局部不一致 / 🟢 基本对齐。

### 1. 段落缩进体系 🔴

CC 做法：**单一 5 列 gutter 栅格** `"  ⎿  "`（2 空 + ⎿ + 2 空），所有工具输出/子内容排在 gutter 右侧的内容列；工具行本体缩进 0（loader 占 2 列）；用户消息缩进 0 靠背景色块区分；thinking 缩进 2；嵌套列表每层 +2。
- `src/components/MessageResponse.tsx:22`（gutter 5 列 dim + 右侧 flex 内容列）
- `src/components/messages/AssistantToolUseMessage.tsx:285`（工具行 0 缩进）
- `src/utils/markdown.ts:180`（`${'  '.repeat(listDepth)}`）

ECode 现状：**三套缩进并存**——assistant 正文/用户消息 0、引用块/列表 2、工具块 3；且工具行 3 与表头符号位（minWidth=2）错位 1 列。「乱」的直接根源。
- `Markdown.tsx`（根无缩进，blockquote `│ ` 2 宽，list `• ` 2 宽）
- `ToolGroupView.tsx`（`paddingLeft={3}`、折叠 preview 再叠 `{'  '}` 2 列、溢出行 3）

差距评级：**🔴** —— 无统一缩进栅格，需收敛为常量表（如 gutter 5 列 / 内容列 2）。

### 2. 块间距节奏 🟡→🔴

CC 做法：**块间恒 1 空行**——`marginTop={addMargin ? 1 : 0}` 模式全局一致；Markdown 内部块用 `gap={1}`。
- `src/components/messages/UserPromptMessage.tsx:76`、`AssistantToolUseMessage.tsx:285`（t5）、`src/components/Markdown.tsx`（`gap={1}`）

ECode 现状：用户消息上 1 下 0；工具组上下各 1；Markdown 块间 **0**（`space` token 渲染成单个空格而非空行，`Markdown.tsx` renderToken `case 'space'`）；Static 项间 0 靠组件自带 margin；动态区 FoldedUserInput 再叠 marginTop（`Conversation.tsx:43`、`UserMessage.tsx:8`、`ToolGroupView.tsx` 外层）。
差距评级：**🔴**（space→空格是明显怪点；margin 硬编码分散在组件里无节奏表）。

### 3. 视觉层级 🟡

CC 做法：工具名 **bold**（+可选反色底）、gutter/元信息一律 dim、用户消息靠背景色块、标题 h1=bold.italic.underline h2/h3=bold、内联 code 用主题蓝。
- `AssistantToolUseMessage.tsx`（bold 工具名）、`MessageResponse.tsx:22`（dim gutter）、`markdown.ts:88,104-135`、`theme.ts:118-167`

ECode 现状：工具块几乎全 dim（名/摘要/preview/折叠提示），仅表头 bold——层级偏平；Markdown 标题单色 `#F5A742`+bold，列表符 dim，代码块 round+cyan 边框（`ToolGroupView.tsx`、`Markdown.tsx`、`GrayStreaming` 全 dim）。
差距评级：**🟡** —— 方向一致但工具名未 bold 突出、层级层次少一档。

### 4. 悬挂缩进 🔴

CC 做法：**gutter 列 + flex 内容列**——Ink wrap 被约束在右列内，续行自动对齐 ⎿ 下方（源码注释明说此意图）；且 `terminalWidth - 10` 预留 gutter 宽度参与 wrap 计算。
- `src/components/messages/CollapsedReadSearchContent.tsx:463-468`（注释："Ink's wrap stays inside the right column so continuation lines indent under ⎿"）
- `src/ink/render-node-to-output.ts:643`、`src/utils/terminal.ts:8,11`

ECode 现状：**基本没有 hanging**——工具输出 `join('\n')` 平铺在 paddingLeft=3 下，续行与首行同列；列表/引用折行续行回 0 列（`wrapAnsi hard:true` 全宽）；仅表格 KVCell 降级有续行对齐（`ToolGroupView.tsx` 展开分支、`Markdown.tsx` AnsiText/KVCell）。
差距评级：**🔴** —— 需把工具输出改为「gutter + 内容列」结构（或 wrap 时预缩进续行）。

### 5. 宽度利用 🟡

CC 做法：正文不限宽（占满终端），但工具输出 wrap 预留 `terminalWidth - 10`（gutter 5 + 余量）；ANSI 感知硬切 wrap；超长输出折叠 `MAX_LINES_TO_SHOW=3` + dim `… +N lines`；工具名行 truncate-end。
- `src/utils/terminal.ts:7-11`、`wrapText()`、`truncate.ts:63`

ECode 现状：**三套宽度公式**——markdown `min(cols,100)`、工具输出 `columns-6`、工具名 clip `columns-14`（`Markdown.tsx` cols()、`ToolGroupView.tsx` expandWidth/clipWidth）。用户消息 Static 全量无截断。
差距评级：**🟡** —— 公式口径不一但各有理由，需统一到一处常量表并明确「扣减=缩进占用」。

### 约束锚点（实施时不可破坏）

- V 线预算：`src/tui/viewport.ts:74` `allocateDynamic`，`Conversation.tsx:125` 调用——块间距增加须走预算。
- 排版常量收敛目标：`INDENT.content / INDENT.gutter / GAP.block / WIDTH.*` 一处定义全 TUI 引用。

## 第二步：实施（清单确认后）

- 改动集中在 Conversation/ToolGroupView/AssistantMessage(UserMessage)/Markdown 渲染层的缩进与间距参数——**收敛成排版常量表**（如 INDENT.content/INDENT.toolOutput/GAP.block——一处定义全 TUI 引用，根治「乱」的结构性办法）；
- 硬约束：V 线预算体系不动摇（空行也是行，块间距增加要走 allocateDynamic 预算）；ESC[3J 硬指标探针必跑；
- 现有测试的帧断言（toContain 类）可能因排版变化失败——允许更新断言但逐条列出（防借机弱化）。

## 验收

全量+tsc+`node scripts/pty-overscreen-probe.cjs` 两连跑（间距变大后超屏风险升高，必跑）+键盘探针（若动输入区）。pty 快照前后对比留档（同一条测试消息渲染前后帧）。
