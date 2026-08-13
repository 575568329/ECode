---
layer: tui
status: stable
related_adr: []
reviewed_doc:
  - 详设/2026-08-12_M2-TUI实施方案_待审核.md（§4 方案 B 流式 markdown）
  - 规范/2026-08-11_MVP-TUI设计规范_待审核.md
  - 解析/2026-08-12_MVP-Provider翻译层与心脏数据流解析_待审核.md（callbacks→TUI 数据流）
---

# ECode MVP 终端 Markdown 渲染调研

> 调研日期：2026-08-13 · 状态：待审核
> 评估 ECode 自建 `Markdown.tsx`（M2）与主流终端 markdown 渲染方案的差距，为 M2 方案 B（流式 markdown）选型提供依据。
> 方法：网上主流库调研 + 本地 5 个开源项目源码对照（claude-code-main / codex / aider / opencode / openclaw）。

---

## 0. 背景与问题

ECode M2 自建了终端 markdown 渲染器（`src/tui/Markdown.tsx` + `mdparse.ts`），渲染已 commit 的助手消息。本文回答三个问题：

1. **架构路线是否主流**？有没有走野路子？
2. **真正的差距在哪**？哪些是有意简化、哪些是真缺口？
3. **M2 方案 B（流式 markdown）该怎么做**？抄谁？

> 结论先行：架构路线完全主流（与 `marked-terminal`/`ink-markdown`/`claude-code` 同源同构），CJK 中文宽度反而是比现成库更强的点；真正的差距只有两处——**流式渲染**和 **OSC 8 链接**；另 `cli-highlight` 是个待还的技术债。

---

## 1. ECode 现状（自建渲染器架构）

```
输入 text
  ├─ hasMarkdownSyntax 快速判定 → 无语法直接纯文本折行（跳过 lexer）
  └─ marked.lexer → block tokens
       ├─ block：renderToken 按 type 映射 Ink 原语（heading/paragraph/code/list/table/blockquote/hr）
       ├─ inline：inlineToAnsi（手写 SGR ANSI）→ wrap-ansi(hard)（按显示宽度折行）→ parseAnsi → <Text> spans
       ├─ 代码块：cli-highlight（动态懒加载 + 模块级单例 Promise）+ 圆角边框
       └─ 表格：cli-table3（CJK 安全）
```

- **流式**：未做（整段 commit 后一次性渲染，流式期是灰字纯文本）—— M2 方案 B.2 已标注
- **链接**：纯文本 `text (href)`，无 OSC 8
- **标题**：统一单色（`#F5A742` + bold），不分 h1-h6（注释：「调研 opencode/aider 单色标题，靠粗体分层」）

---

## 2. 主流方案全景

### 2.1 现成库（npm，Ink 生态）

| 库 | 做法 | CJK | 流式 | OSC8 | 维护 |
|---|---|---|---|---|---|
| **marked-terminal** | `marked` + 自定义 Renderer 产 ANSI（依赖 chalk/cli-highlight/cli-table3） | ❌ 不处理 | ❌ | ❌ | 低 |
| **ink-markdown** | 就是 marked-terminal 的 Ink 包装（依赖 marked + marked-terminal） | ❌ | ❌ | ❌ | **停更**（2023-10） |

关键发现：**ink-markdown 的依赖就是 `marked` + `marked-terminal`**——ECode 的 `marked.lexer + ANSI 中间态 + parseAnsi + <Text>` 与它**同构**，只是 ECode 自写 `parseAnsi`（为 hard wrap + 精细 span），反而更可控。

### 2.2 Agent CLI 项目（本地源码对照）

| 项目 | 栈 | 解析 | 渲染 |
|---|---|---|---|
| **claude-code-main** | TS/Ink/chalk | marked.lexer（带 LRU token cache）| 表格=React flexbox，其余=chalk ANSI→`<Ansi>` |
| **codex** | Rust/ratatui | pulldown-cmark + 自写 unwrap/rewrite | ratatui `Vec<Line>` span |
| **aider** | Python/rich | rich.markdown(commonmark) | rich（console→ANSI）|
| **opencode** | 双栈：TUI 委托 opentui；Web 用 marked+shiki | marked（Web）| Solid.js DOM（Web）|
| **openclaw** | — | **工作树为空（仅 .git）**，跳过 | — |

---

## 3. 分维度对比

| 维度 | ECode | claude-code | codex | aider | opencode(Web) |
|---|---|---|---|---|---|
| 解析 | marked.lexer | marked.lexer + LRU cache | pulldown-cmark + unwrap | rich(commonmark) | marked |
| 渲染 | block→Ink + inline→ANSI→Text | 表格 React / 其余 ANSI | ratatui span | rich | DOM |
| **流式 md** | **未做** | ✅ 顶层 block stable/unstable | ✅ 双边界 + fuzz 测试 | ✅ 滑动窗口 + 自适应节流 | ✅ block 投影 + remend + shiki stream |
| 代码高亮 | cli-highlight(懒加载) | cli-highlight(Suspense) | syntect + two-face | pygments | shiki + @shikijs/stream(worker) |
| 表格 | cli-table3(CJK 安全) | 自写 flexbox(47KB) | ratatui 原生 | rich.table | DOM |
| CJK 宽度 | **wrap-ansi hard** ✅ | 自研 stringWidth | unicode-width | rich/wcwidth | DOM/CSS |
| OSC8 链接 | ❌ 纯文本 | ✅ supportsHyperlinks 降级 | ✅ 语义层分离 | ✅ rich 原生 | N/A(DOM) |

---

## 4. 流式 markdown 专题（M2 方案 B 核心）

业界公认范式：**已渲染的稳定部分冻结，只让「最后一段」可变重排**，避免表格/代码块流式时乱跳。区别只在切分粒度。四种路线：

### 4.1 claude-code —— 顶层 block 边界切分（最推荐 ECode 借鉴）

`StreamingMarkdown`（`src/components/Markdown.tsx:186`）：用 `marked.lexer` 把未闭合 ```` ``` ```` 当单 token 的特性，保证 block 边界安全；boundary 单调递增（只前进），每 delta 只对 unstable 后缀 lexer，O(unstable)。

```ts
// 简化核心
const boundary = stablePrefixRef.current.length
const tokens = marked.lexer(stripped.substring(boundary))   // 只 lex 后缀
// 前面 block 推进 boundary（冻结），最后一段留 unstable
return <Box>
  {stablePrefix && <Markdown>{stablePrefix}</Markdown>}      // memoized 不重 parse
  {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
</Box>
```

### 4.2 codex —— 双边界最严谨 + fuzz 回归（Rust）

`markdown_stream.rs` + `streaming.rs`：换行门控裸源累加 + 双边界（源 & 已渲染行）+ reference-link/inline-directive 触发全量 recompute。**末尾配一整套 fuzz 测试**，断言「流式输出 == 整段渲染」，覆盖 bullet 重复 / UTF-8 字节边界 / 宽字符 / loose-tight 列表 / 栅栏内表格行等。

### 4.3 aider —— 全量渲染 + 滑动窗口（最简但 Ink 不合）

`mdstream.py`：每次 delta 全量渲染整段成行，按 `live_window=6` 行切——稳定头部行 print 到 Live 区上方（进 scrollback），最后 6 行喂 `rich.live.Live` 反复重绘。20fps + 自适应 `min_delay`。**rich.Live 局部刷新，Ink 重绘整屏不适合**，仅参考节流思路。

### 4.4 opencode —— block 投影 + remend heal + shiki stream（Web，最全）

`markdown-stream.ts`：block 级 stable/unstable 投影，末尾未闭合代码块细分 `code/live`；`heal()` 用 `remend` 修复残缺 markdown；高亮走 web worker + `@shikijs/stream` 的 stable/unstable token。**为 DOM 设计，不能直接搬到 Ink**，但 block 投影 + 栅栏闭合感知 + worker 卸载的思路可借鉴。

### 4.5 选型建议

**ECode 选 claude-code 路线**（技术栈完全一致：TS/Ink/marked/cli-highlight，`StreamingMarkdown` 几乎可平移，约 50 行）。codex 的 fuzz 测试用例照抄到 ECode 的流式测试里。aider/opencode 仅参考思路。

---

## 5. 其他维度

### 5.1 OSC 8 可点击链接

现代终端（iTerm2 / Windows Terminal / kitty / WezTerm / ghostty）**全支持** OSC 8。但主流渲染器普遍空缺：marked-terminal/ink-markdown/aider 都不发，**codex 是唯一在 markdown 渲染里原生用 OSC8 的 Agent CLI**，claude-code 社区正在求（issue #13008）。

ECode 直接抄 claude-code 的 `hyperlink.ts`：用 `supports-hyperlinks` 探测，支持时发 `\x1b]8;;URL\x07TEXT\x1b]8;;\x07`（BEL 终止兼容最好），不支持降级纯文本。**~20 行**。坑：link token 内的 text 别再 linkify（避免嵌套两层 OSC8，终端只认最内层）。ECode 的 `parseAnsi` 不用改——OSC8 序列直接拼进 ANSI 串让终端自解释。

### 5.2 CJK 中文宽度（ECode 的优势项）

ECode 用 `wrap-ansi(hard)` → `string-width` → `get-east-asian-width`（按 UAX#11 把字符分 F/W/H/Na/A/N 六类，全角=2 列）。`hard: true` 能在单词中间按显示宽度强制折行——对中文（无空格分词）必需。**marked-terminal / ink-markdown 都不做**（`reflowText` 默认 false 且不基于 string-width）。

依赖现状（2026-08）：`string-width` 8.2.2 / `wrap-ansi` 10.0.0 / `get-east-asian-width` 1.6.0（活跃）。注意 `east-asian-width` 0.1.1 已废弃（2015），别用。

**已知坑**：UAX#11 的 ambiguous 字符（部分 Box Drawing、西文标点）宽度取决于 locale——中日韩 locale 算 2 列、西文算 1 列。`string-width` 默认按西文（1 列）。对中文场景 99% 没问题，但终端表格边框用 ambiguous 字符可能差 1 列。

### 5.3 代码高亮（cli-highlight 技术债）

`cli-highlight` **停更 5 年**（2021-03 的 2.1.11 至今），锁死 `highlight.js 10.x`（当前已 11.x，有已修复的语法 bug）。建议**和流式代码高亮一起换 shiki**——`@shikijs/stream` 的 stable/unstable token 一次解决「流式 + 高亮」（opencode/Cursor/Vercel 系都用）。暂不换能用，挂为已知技术债。

---

## 6. ECode 评估

### 真差距（建议补，按 ROI 排序）
1. **流式 markdown**（最大缺口，M2 方案 B.2 已标注）—— 抄 claude-code `StreamingMarkdown`
2. **OSC 8 链接**（小差距低成本高体验）—— 抄 claude-code `hyperlink.ts`
3. **cli-highlight 技术债**（中差距，不急）—— 和流式高亮合并换 shiki

### 有意简化（可不清，已合理）
- 流式未做：M2 分阶段计划内（方案 B），非遗漏
- `parseAnsi` 只支持 SGR：cli-highlight 只发 SGR，自写 ~80 行子集够用
- 标题单色：调研过 opencode/aider，靠粗体分层
- `del` 删除线不渲染；图片占位；HTML 实体手写 6 个（LLM 常见实体够用）

### ECode 做得比主流更好的
1. **CJK 中文折行**：`wrap-ansi(hard)` 按 UAX#11 全角宽度折行——marked-terminal/ink-markdown 都不做
2. **ANSI 中间态 + 自写 parseAnsi**：比 ink-markdown 吃 Ink 原生 ANSI 更可控（hard wrap、span 精细）
3. **cli-highlight 动态懒加载 + 模块级单例 Promise**：成本只付一次、不阻塞首屏

---

## 7. 落地建议（抄哪里）

| 要做什么 | 抄哪里 | 路径 |
|---|---|---|
| 流式 markdown | **claude-code** `StreamingMarkdown` | `D:\study\claude-code-main\src\components\Markdown.tsx` |
| 流式 fuzz 测试 | **codex** 流式回归用例 | `D:\study\codex\codex-rs\tui\src\markdown_stream.rs`（末尾 tests）|
| OSC8 链接 | **claude-code** `hyperlink.ts` | `D:\study\claude-code-main\src\utils\hyperlink.ts` |
| token 缓存（vscroll 用） | claude-code LRU | `D:\study\claude-code-main\src\utils\markdown.ts` |
| 流式 + shiki（Web 思路） | opencode `markdown-stream.ts` | `D:\study\opencode\packages\session-ui\src\components\markdown-stream.ts` |
| 自适应节流 | aider `mdstream.py` | `D:\study\aider\aider\mdstream.py` |

---

## 8. 反驳与风险（什么情况下选错）

- **若选 claude-code 流式路线后想支持 reference-style 链接定义 `[ref]: url`**：claude-code 路线会失效（ref 能影响任意前后 block），需升级到 codex 的双边界 + 触发 recompute。ECode 目前不支持 ref 链接，短期无风险。
- **若换 shiki**：体积大（~几 MB grammar），首屏加载需 worker 卸载（参考 opencode），否则拖慢启动。MVP 留 cli-highlight 可接受。
- **`remend`（opencode 用的残缺 md 修复器）**：其 GitHub README 抓取失败，行为从 opencode 源码用法 `remend(text, { linkMode: "text-only" })` 和 npm 元数据（1.3.0 / 零依赖 / 2026-03）推断。**若选 opencode 路线，落地前 `npm view remend` 核对 API**。ECode 选 claude-code 路线则不依赖 remend。
- **OSC8 在 CI/管道环境**：非交互终端不支持，`supports-hyperlinks` 会正确返回 false 降级——但需确保探测在渲染前完成（别每帧探测）。

---

## 附录：引用

**本地源码**
- claude-code-main：`src/components/Markdown.tsx`、`src/components/MarkdownTable.tsx`、`src/utils/markdown.ts`（`formatToken`）、`src/utils/hyperlink.ts`、`src/utils/cliHighlight.ts`、`src/ink/stringWidth.js`
- codex：`codex-rs/tui/src/markdown_render/{streaming,markdown}.rs`、`markdown_stream.rs`、`markdown_render.rs`、`terminal_hyperlinks.rs`、`table_detect.rs`
- aider：`aider/mdstream.py`、`aider/io.py`
- opencode：`packages/session-ui/src/components/{markdown-stream,markdown.worker}.ts`；`packages/tui`（委托 opentui）

**网络**
- marked-terminal：https://github.com/mikaelbr/marked-terminal
- ink-markdown：https://www.npmjs.com/package/ink-markdown
- Shiki stream：https://shiki.style/packages/stream
- OSC8 终端支持清单：https://github.com/Alhadis/OSC8-Adoption/
- supports-hyperlinks：https://www.npmjs.com/package/supports-hyperlinks
- string-width / wrap-ansi / get-east-asian-width：https://www.npmjs.com/package/string-width
- cli-highlight（停更）：https://www.npmjs.com/package/cli-highlight
- marked-shiki：https://www.npmjs.com/package/marked-shiki
- Claude Code OSC8 诉求：https://github.com/anthropics/claude-code/issues/13008
- UAX#11：http://www.unicode.org/reports/tr11/
- ambiguous 宽度 bug（kitty）：https://github.com/kovidgoyal/kitty/issues/6560
