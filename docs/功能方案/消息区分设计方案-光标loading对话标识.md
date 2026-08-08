> ⚠️ **已废弃（2026-08-08）**：本方案已整合升级到 [`消息队列与交互重做方案.md`](消息队列与交互重做方案.md)（§5 对话气泡 + §6 动效，含三角色审阅修正：助手保留 ◆+左竖线、光标不闪烁、只留 thinking loader）。
> 实现以新方案为准；本文件仅作早期讨论溯源保留。

# 消息视觉区分 + 光标 / loading 动效设计方案【已废弃 → 见消息队列与交互重做方案.md】

> 范围：参考 Claude Code（以下简称 CC）本尊源码，为 ECode 设计「消息角色区分 + 输入光标动效 + loading 动效」的统一视觉语言。
>
> 本文只出**设计**，不含实现代码。落地以本文档为契约，按 §4 改动清单逐条执行。
>
> 调研对象：
> - CC 源码：`D:/Study/claude-code-main/`
> - ECode 现状：`D:/Study/ECode/src/ui/`

---

## 1. CC 源码实证

### 1.1 用户消息：整行 backgroundColor，无 `>`，无 "You" 前缀

**关键文件**：`D:/Study/claude-code-main/src/components/messages/UserPromptMessage.tsx:76`

```tsx
<Box
  flexDirection="column"
  marginTop={addMargin ? 1 : 0}
  backgroundColor={isSelected ? 'messageActionsBackground' : useBriefLayout ? undefined : 'userMessageBackground'}
  paddingRight={useBriefLayout ? 0 : 1}
>
```

**结论**：
- CC **用整行 `backgroundColor={userMessageBackground}`** 区分用户消息（不是左边框，不是 `>` 前缀）。
- **没有 `>` 引导符号**，也**没有 "You" 文本前缀**。
- `useBriefLayout` 模式下背景退化为 `undefined`，切换为 label 布局。
- `isSelected`（被选中操作时）切到 `messageActionsBackground`。

### 1.2 助手消息：BLACK_CIRCLE 圆点，minWidth=2 占位

**关键文件**：`D:/Study/claude-code-main/src/components/messages/AssistantTextMessage.tsx:232`

```tsx
t4 = shouldShowDot && (
  <NoSelect fromLeftEdge={true} minWidth={2}>
    <Text color={isSelected ? "suggestion" : "text"}>{BLACK_CIRCLE}</Text>
  </NoSelect>
)
```

外层（行号附近）：
```tsx
<Box flexDirection="row" backgroundColor={isSelected ? "messageActionsBackground" : undefined}>
  {t4 /* 圆点 */}
  <Box flexDirection="column" flexShrink={1}>
    <Markdown>...</Markdown>
  </Box>
</Box>
```

**`BLACK_CIRCLE` 定义**：`D:/Study/claude-code-main/src/constants/figures.ts`
```ts
BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
```

**结论**：
- CC 助手消息用 **`●` 圆点**（U+25CF；macOS 用 `⏺` U+23FA）做前导，**不是 `◆`、不是 `⎿`、不是 "Claude" 文本**。
- 颜色用 **`text`（普通正文色）**；选中时切到 `suggestion`（更暗的灰色）—— 平时是低调灰圆点。
- `minWidth={2}` + `NoSelect`：圆点占 2 字宽且不可被复制选中，对齐下方 markdown 多行文本的缩进。

### 1.3 工具结果 / 嵌套响应：`⎿` 符号

**关键文件**：`D:/Study/claude-code-main/src/components/MessageResponse.tsx:22`

```tsx
<NoSelect fromLeftEdge={true} flexShrink={0}>
  <Text dimColor={true}>{"  "}⎿  </Text>
</NoSelect>
```

**结论**：
- `⎿`（U+23BF）**不是助手消息用的**，是工具结果 / 错误 / 嵌套响应的缩进引导。
- 颜色用 `dimColor`（淡化），不是品牌色。

### 1.4 输入框光标：反色块状光标（inverse video），不是下划线

**关键文件**：`D:/Study/claude-code-main/src/utils/Cursor.ts:203-299`

```ts
render(cursorChar, mask, invert, ghostText?, maxVisibleLines?) {
  // ...
  for (const { segment } of getGraphemeSegmenter().segment(displayText)) {
    if (cursorFound) { afterCursor += segment; continue; }
    const nextWidth = currentWidth + stringWidth(segment);
    if (nextWidth > column) {
      atCursor = segment   // 光标落在该字符上
      cursorFound = true
    } else {
      currentWidth = nextWidth
      beforeCursor += segment
    }
  }
  // 关键：用 invert 函数反色渲染光标位置的字符
  renderedCursor = cursorChar ? invert(atCursor) : atCursor
  return beforeCursor + renderedCursor + ghostSuffix + afterCursor.trimEnd()
}
```

**结论**：
- CC 光标是 **「反色块状光标」**（IDE 风格）：把光标位置的那个字符 **背景色 / 前景色反转** 渲染，光标在行尾时用 `cursorChar` 占位然后反色。
- **不是闪烁**，**不是 `_` 下划线**。
- `invert` 是 ANSI 反色函数（`\x1b[7m...\x1b[27m`），整字符 cell 反色。
- 光标位置精确到 grapheme（含 emoji / CJK 宽字符处理）。

### 1.5 Spinner：星号家族帧 + 往返弹跳（非 braille）

**关键文件 1**：`D:/Study/claude-code-main/src/components/Spinner/utils.ts:4-11`

```ts
function getDefaultCharacters(): SpinnerCharacter[] {
  if (env.platform === 'darwin') return ['·', '✢', '✳', '✶', '✻', '✽']
  return ['·', '✢', '*', '✶', '✻', '✽']  // 非 macOS 把 ✳ 退化为 *
}
```

**关键文件 2**：`D:/Study/claude-code-main/src/components/Spinner/SpinnerGlyph.tsx`

```ts
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()]
// 即 12 帧：· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢ ·（来回弹跳）
const REDUCED_MOTION_DOT = '●'
```

**关键文件 3**：`D:/Study/claude-code-main/src/components/Spinner/useShimmerAnimation.ts`
```ts
glimmerSpeed = mode === 'requesting' ? 50 : 200  // 思考 200ms/帧，请求 50ms/帧
// stalled 时返回 -100 暂停动画
```

**结论**：
- CC 用**星号家族帧**（`· ✢ ✳ ✶ ✻ ✽`），不是 ECode 现有的 braille（`⠋⠙⠹...`）。
- 帧序列是 `[正序, 逆序]` 拼接的 12 帧，**往返弹跳**而非单向循环。
- 帧速**自适应阶段**：思考态 200ms，请求态 50ms。
- 减少动效偏好（`REDUCED_MOTION`）→ 退化为静态 `●`。

### 1.6 AnimatedAsterisk（logo 闪光）：HSL 色相旋转

**关键文件**：`D:/Study/claude-code-main/src/components/LogoV2/AnimatedAsterisk.tsx`

```ts
TEARDROP_ASTERISK = '✻'  // U+273B
// 50ms 帧切换 HSL 色相，SWEEP_DURATION_MS=1500, SWEEP_COUNT=2
// SETTLED_GREY = rgb(153, 153, 153)  稳定后变灰
```

**结论**：CC 的 `✻` 启动动画是 **HSL 色相旋转**（彩虹色 sweep 1.5 圈后稳定为灰色），用 `useAnimationFrame`（fork 私有 hook）。

### 1.7 ShimmeredInput（输入框闪光）

**关键文件**：`D:/Study/claude-code-main/src/components/PromptInput/ShimmeredInput.tsx`

```ts
useAnimationFrame(hasShimmer ? 50 : null)
```

**结论**：输入框可发光（shimmer），50ms 频率，依赖 fork 私有 `useAnimationFrame`。**标准 ink 无此 hook**，ECode 不能直接照搬。

### 1.8 CC 主题色（userMessageBackground）

**关键文件**：`D:/Study/claude-code-main/src/utils/theme.ts`

| 主题 | userMessageBackground | userMessageBackgroundHover | messageActionsBackground |
|------|----------------------|----------------------------|--------------------------|
| light | `rgb(240, 240, 240)` | `rgb(252, 252, 252)` | `rgb(232, 236, 244)` |
| dark | `rgb(55, 55, 55)` | `rgb(70, 70, 70)` | `rgb(44, 50, 62)` |
| light-ansi | `ansi:white` | — | — |
| dark-ansi | `ansi:blackBright` | — | — |

---

## 2. ECode 现状问题

### 2.1 用户消息：左边框 + 「你」文本前缀（与 CC 整行背景方案背离）

**文件**：`D:/Study/ECode/src/ui/chat-view.tsx:24-41`

```tsx
case 'user':
  return (
    <Box
      flexDirection="column"
      {...leftBorder}                // ❌ 左边框（CC 是整行 bg）
      borderColor={T.border}
      paddingLeft={1}
      marginTop={1}
    >
      <Text>
        <Text color={T.user} bold>
          {SYMBOLS.user} 你           // ❌ "你" 文本前缀（CC 无任何文本前缀）
        </Text>
      </Text>
      <Text color={T.muted}>{msg.text}</Text>
    </Box>
  );
```

**问题**：
- 用 `leftBorder`（仅一根竖线）而非整行背景色，视觉区分度弱。
- 显式 `❯ 你` 文本前缀，啰嗦；CC 完全靠背景色区分，不加任何前缀文字。
- `theme.ts:20` 已定义 `userBg: '#313244'` 但**从未被引用启用**（dead token）。
- 用户消息正文用 `T.muted`（灰），与系统消息混淆。

### 2.2 助手消息：`◆ ECode` 文本前缀（与 CC 圆点方案背离）

**文件**：`D:/Study/ECode/src/ui/chat-view.tsx:42-54`（已完成消息）+ `113-118`（流式）

```tsx
case 'assistant':
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={T.brand} bold>
          {SYMBOLS.brand} ECode        // ❌ "◆ ECode" 文本前缀（CC 是 ● 圆点）
        </Text>
      </Text>
      <Box paddingLeft={4}>
        <MarkdownRenderer text={msg.text} />
      </Box>
    </Box>
  );
```

流式区段（第 113-118 行）同样问题：
```tsx
<Text color={T.brand} bold>{SYMBOLS.brand} ECode</Text>
```

**问题**：
- 用 `◆ ECode` 显式品牌前缀，每条回答都重复展示，噪声大。
- CC 用 `●`（BLACK_CIRCLE U+25CF）单字符圆点，颜色用 `text`（普通），低调且不抢眼。
- ECode 的 `T.brand`（青色 `#4ECDC4`）做整行前缀 + bold，过度醒目。

### 2.3 输入光标：静态下划线 `_`，无动效

**文件**：`D:/Study/ECode/src/ui/input-bar.tsx:160-164`

```tsx
<Box>
  <Text color={T.user}>{SYMBOLS.user} </Text>
  <Text>{displayed}</Text>
  <Text color={T.muted}>_</Text>     // ❌ 静态下划线，无闪烁，无反色
</Box>
```

**问题**：
- 用 `_`（U+005F ASCII 下划线）做光标，**完全静态**，没有动效。
- 颜色用 `T.muted`（灰），与品牌色脱节，视觉不显眼。
- 输入位置不直观（用户分不清光标在 `_` 左还是右）。
- CC 是反色块状光标（invert video），输入位置一目了然。

### 2.4 disabled 态：`▲ running` 文本提示

**文件**：`D:/Study/ECode/src/ui/input-bar.tsx:141-148`

```tsx
if (disabled) {
  return (
    <Text color={T.warning}>
      {SYMBOLS.warning} running · {''}
      <Text color={T.muted}>esc to interrupt</Text>
    </Text>
  );
}
```

**问题**：仅文本提示 `▲ running`，**没有 spinner 动效**。CC 在等待时会在输入区或 logo 处展示动效。

### 2.5 Spinner：braille 帧，单向循环

**文件**：`D:/Study/ECode/src/ui/spinner.tsx` + `D:/Study/ECode/src/ui/theme.ts:42`

```ts
export const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';  // braille 10 帧单向
```

**问题**：
- 用 braille 帧序列，与 CC 的星号家族（`· ✢ ✳ ✶ ✻ ✽`）风格不一致。
- 单向循环（10 帧重复），不如 CC 的「往返弹跳」（12 帧 `[正序, 逆序]`）优雅。
- 80ms/帧固定，无阶段自适应（CC 思考 200ms、请求 50ms）。

### 2.6 工具运行态：spinner 在但流式文本无动效

**文件**：`D:/Study/ECode/src/ui/tool-panel.tsx:23-33`

```tsx
export function ToolRunning({ name, arg }: ToolRunningProps): React.ReactElement {
  return (
    <Box>
      <Spinner color={T.brand} />
      <Text color={T.muted}> {SYMBOLS.tool} {name}</Text>
      ...
    </Box>
  );
}
```

**现状**：工具运行态有 spinner（好）；但**纯文本流式（无工具调用）时，仅有 `◆ ECode` 静态前缀，无任何动效**指示「正在思考」。

---

## 3. 推荐设计语言

### 3.1 设计原则

1. **去文本前缀**：删除「你」「ECode」字样，靠**视觉符号 + 背景色**区分角色（对齐 CC）。
2. **符号 minimalist**：用户消息无前缀符号（整行背景已经够明显）；助手消息用单字符 `●` 圆点；保留 ECode 现有 `❯` 仅作 **input prompt 引导**（不进消息流）。
3. **背景色优先于边框**：整行 backgroundColor 视觉强且不破坏对齐；边框仅用于次级容器（工具面板）。
4. **动效克制可见**：光标必须动（输入位置反馈），spinner 必须动（loading 反馈），但呼吸 / shimmer 等锦上添花项可选。
5. **不依赖 fork hook**：ECode 用标准 ink，无 `useAnimationFrame`，所有动效用 `setInterval + useState` 实现（已有 spinner.tsx 是此模式）。

### 3.2 统一符号体系

| 角色 | 当前 | 推荐符号 | Unicode | 颜色 | 备注 |
|------|------|---------|---------|------|------|
| 用户消息（消息流） | `❯ 你` | **无符号**（整行背景） | — | — | 对齐 CC：背景色 + 无前缀 |
| 助手消息（消息流） | `◆ ECode` | **`●`** | U+25CF BLACK_CIRCLE | `T.brand`（青）| 对齐 CC（CC 用 text 灰，ECode 保留品牌青识别） |
| 工具结果（嵌套） | `↳` | `⎿`（可选） | U+23BF | `T.muted` dimColor | CC 风格，可选迁移 |
| 输入光标 | `_`（静态） | **`▋` 块状闪烁** | U+2588 LEFT FIVE EIGHTHS BLOCK | `T.user`（蓝） | 500ms 闪烁，块状更显眼 |
| 输入 prompt 引导 | `❯` | `❯`（保留） | U+276F | `T.user` | 不进消息流，仅 input-bar 用 |
| Spinner（建议改） | braille `⠋⠙⠹...` | **星号家族 `· ✢ ✳ ✶ ✻ ✽`** | — | `T.brand` | 对齐 CC |
| Spinner 减少动效 | — | `●`（静态） | U+25CF | `T.brand` | 无障碍兜底 |

**说明**：
- 用户消息**不加任何前缀符号**，整行 `T.userBg` 背景已经足够区分（CC 实证）。
- 助手圆点用 `●`（U+25CF）而非 `⏺`（U+23FA），跨平台一致性更好（CC 仅 macOS 用 ⏺）。
- 工具结果 `⎿` 是**可选迁移项**，当前 `↳`（U+21B3）也合理，不强制改。

### 3.3 颜色 token 调整

**新增**（`D:/Study/ECode/src/ui/theme.ts`）：

```ts
export const T = {
  // ... 现有 17 个保留
  userBg: '#313244',          // 已存在，本方案启用
  userBgHover: '#45475A',     // 新增（预留 hover 态，M4 用）
  assistantDot: '#4ECDC4',    // 新增（等同 brand，语义独立；后续如调色不绑死）
  cursor: '#89B4FA',          // 新增（等同 user，输入光标色）
} as const;
```

**对照 CC 主题**：
- CC dark `userMessageBackground = rgb(55, 55, 55)` → ECode `userBg = #313244`（Catppuccin Mocha Basalt），明度相近。
- CC `userMessageBackgroundHover = rgb(70, 70, 70)` → ECode `userBgHover = #45475A`（Surface1）。

### 3.4 背景色用法规范

| 场景 | backgroundColor | padding | marginTop | 备注 |
|------|----------------|---------|-----------|------|
| 用户消息（消息流） | `T.userBg`（整行） | left=1, right=1 | 1 | 去 leftBorder，去 ❯ 你 |
| 助手消息（消息流） | 无 | left=2（圆点占位对齐） | 1 | 仅 `●` 圆点，无背景 |
| 助手消息（流式态） | 无 | left=2 | 0 | 圆点旁可加呼吸动效（可选） |
| BlockTool 面板 | `T.toolBg`（已存在） | left=1 | 0 | 不变 |
| 系统消息（warning/error） | 无 | left=1（保留 leftBorder） | 1 | 维持现状，与角色消息拉开层级 |

**关键**：用户消息从「左边框 + paddingLeft」改为「整行 backgroundColor + paddingLeft/Right」，**与 CC 渲染机制完全一致**。

### 3.5 动效方案（核心）

ECode 用标准 ink，无 fork 的 `useAnimationFrame`。所有动效**统一用 `setInterval + useState`** 实现，封装到 `use-blink.ts` hook。

#### 3.5.1 输入光标：块状闪烁（推荐方案）

**频率**：500ms 切换（标准光标闪烁速率，对齐 VS Code 默认 `editor.cursorBlinkRate`）。
**字符**：`▋`（U+2588 LEFT FIVE EIGHTHS BLOCK，左五分之四块）—— 显眼但不挡字符。

```tsx
// 概念伪代码（落地参考 §4.3）
function useBlink(intervalMs = 500): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn(v => !v), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return on;
}

// 渲染
const cursorOn = useBlink(500);
<Text color={T.cursor}>{cursorOn ? '▋' : ' '}</Text>
```

**为什么不照搬 CC 反色块状光标**：
- CC 的 invert 反色需要逐字符拆分 + ANSI `\x1b[7m` 转义，标准 ink 的 `<Text>` 不直接支持「按字符反色」。
- 实现复杂度高（需自己拆 grapheme、拼接 ANSI），收益不如块状闪烁直观。
- 块状 `▋` 闪烁是 **行业惯例**（bash / zsh / fish 部分主题、IBM 终端传统），用户认知成本低。

**可选进阶**（M5+）：用 ANSI `\x1b[7m<char>\x1b[27m` 实现真正的反色块状光标，但需手写 ink renderer hook，本期不做。

#### 3.5.2 Spinner：星号家族帧 + 往返弹跳（推荐）

**帧序列**：
```ts
const BASE_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'] as const;
const SPINNER_FRAMES = [...BASE_FRAMES, ...[...BASE_FRAMES].reverse()] as const;
// 12 帧：· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢ ·
```

**帧速**：
- 默认（思考态）：120ms/帧（比 CC 的 200ms 略快，ECode 体感调优）。
- 流式文本态（streaming）：80ms/帧（紧迫感）。
- 工具运行态（tool running）：120ms/帧。

**减少动效兜底**：检测 `process.env.NO_COLOR` 或新增 `TERM_DUMB` 检测 → 退化为静态 `●`。

#### 3.5.3 流式文本「思考中」指示（可选锦上添花）

**场景**：纯文本流式（无工具调用），仅有 `●` 圆点，缺动效。
**方案**：在流式态给 `●` 加**呼吸动效**（颜色 `T.brand` ↔ `T.muted` 切换，800ms）。

```tsx
// 概念：流式态圆点呼吸
const breathing = useBreathe(800);  // 0~1 渐变（用 setInterval 模拟）
<Text color={breathing ? T.brand : T.muted}>●</Text>
```

**优先级 P1**：核心动效（光标 + spinner）落地后再加。

---

## 4. 落地改动清单

按文件 + 行号列出。每条标注：[P0 必须 / P1 建议 / P2 可选]。

### 4.1 `src/ui/theme.ts`（token + 符号 + spinner 帧）

**当前内容**（行 1-43）：

```ts
export const T = {
  // ... 17 个
  userBg: '#313244', // 用户消息背景（角色区分，M3.5 Phase 1）  ← 行 20，已存在未启用
  // ...
};

export const SYMBOLS = {
  user: '❯',     // 行 30
  brand: '◆',    // 行 31
  // ...
};

export const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';  // 行 42
```

**改动**：

| 行号 | 改动 | 优先级 |
|------|------|--------|
| 第 20 行后 | 新增 token：`userBgHover: '#45475A'`、`assistantDot: '#4ECDC4'`、`cursor: '#89B4FA'` | P0 |
| 第 31 行 | `brand: '◆'` **保留**（input-bar 不用，但 BlockTool 等场景留用） | — |
| 第 33 行后（SYMBOLS 末尾） | **新增** `assistant: '●'`（U+25CF BLACK_CIRCLE，助手消息圆点专用） | P0 |
| 第 42 行 | **替换** SPINNER_FRAMES 为星号家族 12 帧数组：`['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢', '·']` | P1 |

**说明**：
- `SYMBOLS.brand = '◆'` 不删，避免破坏其他可能引用（`SYMBOLS.brand` 检查范围：当前仅 chat-view，但保守起见保留）。
- 新增 `SYMBOLS.assistant = '●'` 语义独立于 brand，便于后续调整助手视觉时不牵连。

### 4.2 `src/ui/chat-view.tsx`（消息流角色区分）

#### 4.2.1 用户消息 [P0]

**当前**（行 24-41）：

```tsx
case 'user':
  return (
    <Box
      flexDirection="column"
      {...leftBorder}
      borderColor={T.border}
      paddingLeft={1}
      marginTop={1}
    >
      <Text>
        <Text color={T.user} bold>
          {SYMBOLS.user} 你
        </Text>
      </Text>
      <Text color={T.muted}>{msg.text}</Text>
    </Box>
  );
```

**改为**：

```tsx
case 'user':
  return (
    <Box
      flexDirection="column"
      backgroundColor={T.userBg}        // ✅ 整行背景（CC 风格）
      paddingLeft={1}                   // ✅ 左右内边距
      paddingRight={1}
      marginTop={1}
    >
      <Text color={T.user}>{msg.text}</Text>  // ✅ 去掉「❯ 你」前缀；正文用 T.user（蓝）替代 T.muted（灰）
    </Box>
  );
```

**变更点**：
- 删 `{...leftBorder}` + `borderColor={T.border}`（行 28-29）。
- 删 `<Text>{SYMBOLS.user} 你</Text>` 整段（行 34-38）。
- 加 `backgroundColor={T.userBg}`。
- 加 `paddingRight={1}`（与 paddingLeft 对称）。
- 正文颜色 `T.muted` → `T.user`（提升可读性，与背景对比度足）。

#### 4.2.2 助手消息（已完成态）[P0]

**当前**（行 42-54）：

```tsx
case 'assistant':
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={T.brand} bold>
          {SYMBOLS.brand} ECode
        </Text>
      </Text>
      <Box paddingLeft={4}>
        <MarkdownRenderer text={msg.text} />
      </Box>
    </Box>
  );
```

**改为**：

```tsx
case 'assistant':
  return (
    <Box flexDirection="row" marginTop={1}>           {/* row 横向：圆点 + 文本 */}
      <Text color={T.assistantDot}>{SYMBOLS.assistant}</Text>  {/* ✅ ● 圆点，无「ECode」前缀 */}
      <Box flexDirection="column" flexShrink={1} paddingLeft={1}>
        <MarkdownRenderer text={msg.text} />
      </Box>
    </Box>
  );
```

**变更点**：
- 外层 `flexDirection="column"` → `"row"`（圆点和文本横向排列，对齐 CC）。
- 删 `<Text>{SYMBOLS.brand} ECode</Text>` 整段（行 45-49）。
- 加 `<Text color={T.assistantDot}>{SYMBOLS.assistant}</Text>`（● 圆点，单字符）。
- 内层 Box `paddingLeft={4}` → `paddingLeft={1}`（圆点已占 1 字宽 + 1 间隔）。
- 加 `flexShrink={1}`（长文本换行收缩，对齐 CC）。

#### 4.2.3 助手消息（流式态）[P0]

**当前**（行 112-118）：

```tsx
{state.streamingText ? (
  <Text>
    <Text color={T.brand} bold>{SYMBOLS.brand} ECode</Text>
    {'\n'}
    <MarkdownRenderer text={state.streamingText} streaming />
  </Text>
) : null}
```

**改为**：

```tsx
{state.streamingText ? (
  <Box flexDirection="row">                                {/* row 横向：圆点 + 流式文本 */}
    <Text color={T.assistantDot}>{SYMBOLS.assistant}</Text>{/* ✅ ● 圆点 */}
    <Box flexDirection="column" flexShrink={1} paddingLeft={1}>
      <MarkdownRenderer text={state.streamingText} streaming />
    </Box>
  </Box>
) : null}
```

**变更点**：
- 删 `<Text>{SYMBOLS.brand} ECode</Text>` + `{'\n'}`。
- 加 `<Text color={T.assistantDot}>{SYMBOLS.assistant}</Text>`。
- 包裹 `<Box flexDirection="row">` 横向布局。
- 当前位置外层 `paddingLeft={4}`（行 111）调整为 `paddingLeft={0}`（圆点 + 文本自适应对齐，与已完成消息一致）。

#### 4.2.4 工具消息 [P2 可选]

**当前**（行 55-60）：用 `paddingLeft={4}` 缩进显示工具结果。

**建议**：保持不变，或改为 CC 风格 `⎿` 引导（U+23BF）：
```tsx
case 'tool':
  return (
    <Box flexDirection="row">
      <Text color={T.muted}>  ⎿  </Text>   {/* CC 嵌套响应符号 */}
      <Box flexDirection="column">
        <ToolDone ... />
      </Box>
    </Box>
  );
```

**优先级 P2**：当前 `↳`（SYMBOLS.result）也合理，不强制改。

### 4.3 `src/ui/input-bar.tsx`（输入光标动效）

#### 4.3.1 启用态光标 [P0]

**当前**（行 160-164）：

```tsx
<Box>
  <Text color={T.user}>{SYMBOLS.user} </Text>
  <Text>{displayed}</Text>
  <Text color={T.muted}>_</Text>
</Box>
```

**改为**：

```tsx
<Box>
  <Text color={T.user}>{SYMBOLS.user} </Text>
  <Text>{displayed}</Text>
  <Text color={T.cursor}>{cursorOn ? '▋' : ' '}</Text>   {/* ✅ 块状闪烁 */}
</Box>
```

**配套**：组件顶部加 hook 调用：
```tsx
const cursorOn = useBlink(500);   // 见 §4.3.3 新建 hook
```

**变更点**：
- 删 `<Text color={T.muted}>_</Text>`（行 163）。
- 加 `<Text color={T.cursor}>{cursorOn ? '▋' : ' '}</Text>`。
- 光标字符 `_`（U+005F）→ `▋`（U+2588）。
- 颜色 `T.muted`（灰）→ `T.cursor`（蓝，与 input prompt `❯` 同色，视觉一体）。

#### 4.3.2 disabled 态 [P1]

**当前**（行 141-148）：纯文本 `▲ running · esc to interrupt`，无动效。

**建议加 spinner**：

```tsx
if (disabled) {
  return (
    <Box flexDirection="row">
      <Spinner color={T.brand} />                        {/* ✅ 思考 spinner */}
      <Text color={T.warning}> running · </Text>
      <Text color={T.muted}>esc to interrupt</Text>
    </Box>
  );
}
```

**变更点**：
- 引入 `Spinner` 组件（已存在于 `src/ui/spinner.tsx`）。
- 替换 `▲`（SYMBOLS.warning）为动态 spinner，提供「正在运行」的视觉反馈。
- 布局改为 `<Box flexDirection="row">` 横向排列 spinner + 文本。

#### 4.3.3 新建 `src/ui/use-blink.ts` [P0]

**职责**：通用闪烁 hook，光标 + 呼吸动效共用。

```tsx
// use-blink.ts
import { useState, useEffect } from 'react';

/** 在 true / false 之间定时切换（用于光标闪烁、呼吸动效）。
 *  intervalMs=500 → 光标；800 → 呼吸。
 *  卸载时清 interval，disabled 时 caller 自行决定是否调用。 */
export function useBlink(intervalMs: number = 500): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn(v => !v), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return on;
}
```

**说明**：单一 hook，可在光标、流式圆点呼吸、tool running 等多处复用。

### 4.4 `src/ui/spinner.tsx`（spinner 帧改星号家族）[P1]

**当前**（行 1-?，使用 `SPINNER_FRAMES` 字符串）：

**改动**：
- 引入 `theme.ts` 的新 `SPINNER_FRAMES` 数组（12 帧）。
- 帧索引 `index = Math.floor(Date.now() / intervalMs) % frames.length`。
- 默认 `intervalMs = 120`（替代当前 80ms）。

**减少动效兜底**（可选 P2）：
```tsx
const reduceMotion = process.env.TERM_DUMB || process.env.NO_COLOR;
const frame = reduceMotion ? '●' : SPINNER_FRAMES[index];
```

### 4.5 `src/ui/tool-panel.tsx`（ToolRunning spinner 颜色）[P0]

**当前**（行 23-33）：`<Spinner color={T.brand} />` + `T.muted` 工具名。

**改动**：保留不变（spinner 改星号家族后自动生效，颜色仍用 brand 作为唯一动态亮点，符合「降存在感」注释）。

### 4.6 改动汇总表

| 文件 | 改动类型 | 优先级 | 行号 |
|------|---------|--------|------|
| `src/ui/theme.ts` | 新增 3 token + SYMBOLS.assistant + 替换 SPINNER_FRAMES | P0 / P1 | 20 后 / 33 后 / 42 |
| `src/ui/chat-view.tsx` | 用户消息：leftBorder → bg / 去「❯ 你」 | P0 | 24-41 |
| `src/ui/chat-view.tsx` | 助手消息已完成：去「◆ ECode」+ 加 ● 圆点 | P0 | 42-54 |
| `src/ui/chat-view.tsx` | 助手消息流式：去「◆ ECode」+ 加 ● 圆点 | P0 | 112-118 |
| `src/ui/chat-view.tsx` | 工具消息（可选 ⎿） | P2 | 55-60 |
| `src/ui/input-bar.tsx` | 启用态光标：`_` → `▋` 闪烁 | P0 | 160-164 |
| `src/ui/input-bar.tsx` | disabled 态加 spinner | P1 | 141-148 |
| `src/ui/use-blink.ts` | 新建通用闪烁 hook | P0 | 新文件 |
| `src/ui/spinner.tsx` | 帧序列改星号家族 | P1 | 全文件 |

---

## 5. 验收标准

### 5.1 功能验收（必通过）

| # | 场景 | 验收标准 | 涉及文件 |
|---|------|---------|---------|
| 1 | 用户消息整行背景 | 输入「测试」→ 回车 → 消息流中该消息**整行带 #313244 背景**，左右各 1 字符留白，无 `❯` 无「你」字样 | chat-view.tsx:24-41 |
| 2 | 助手消息圆点 | 助手回答 → 消息流中该消息**首行有 `●` 圆点**（青色），无 `◆` 无「ECode」字样，markdown 正文紧跟圆点右侧 | chat-view.tsx:42-54 |
| 3 | 流式助手圆点 | 助手流式输出中 → 动态区显示 `●` 圆点 + 实时文本，无「◆ ECode」字样 | chat-view.tsx:112-118 |
| 4 | 输入光标闪烁 | 启动 REPL → 输入框光标 **`▋` 块状字符，500ms 闪烁**（亮 500ms / 灭 500ms），蓝色（T.cursor） | input-bar.tsx:160-164, use-blink.ts |
| 5 | disabled 态 spinner | 提交任务进入 streaming → InputBar 区域显示 **brand 色 spinner 旋转** + "running · esc to interrupt" | input-bar.tsx:141-148 |
| 6 | Spinner 帧变化 | 任意 spinner（工具运行 / disabled 态）→ 显示 **星号家族帧** `· ✢ ✳ ✶ ✻ ✽`（往返弹跳），非 braille | spinner.tsx |
| 7 | 现有功能不回归 | 工具 Inline / Block 双模式正常、slash 命令 picker 正常、Ctrl+O pager 正常 | 全 UI |

### 5.2 视觉验收（人工检视）

启动 `npm run dev -- "列出当前目录文件"`，观察：

- [ ] 用户消息整行灰底（#313244），与终端默认背景有明显层级差。
- [ ] 助手消息圆点 `●` 青色，对齐 markdown 首行，多行回答缩进一致。
- [ ] 输入光标 `▋` 蓝色块状，肉眼可见闪烁节奏（不卡顿、不融合）。
- [ ] 思考态 spinner 星号 `✻` 旋转优雅，无 braille 模式机械感。
- [ ] 整体视觉对齐 CC 风格（背景色区分 + 圆点 + 块状光标 + 星号 spinner）。

### 5.3 边界场景

| # | 场景 | 验收 |
|---|------|------|
| 1 | 中文等宽字符对齐 | 用户消息中文「测试」背景行宽正确（不溢出、不截断） |
| 2 | 长文本换行 | 助手长文本 markdown 多行，每行均与 `●` 圆点右对齐（paddingLeft=1） |
| 3 | 流式换行 | 流式中文 / 代码块多行，圆点始终在首行行首，不跳动 |
| 4 | disabled 切换 | idle → streaming → idle 切换时光标恢复闪烁，spinner 出现/消失平滑 |
| 5 | 减少动效（P2） | `TERM_DUMB=1 npm run dev` → spinner 退化为静态 `●`，光标仍闪烁（或同步关闭）|

### 5.4 不做项（YAGNI）

明确**不在本期范围**：

- ❌ 反色块状光标（CC invert video，标准 ink 不直接支持，复杂度高）
- ❌ HSL 色相旋转 logo 闪光（依赖 fork useAnimationFrame）
- ❌ Shimmer 输入框发光（依赖 fork useAnimationFrame）
- ❌ 选中态 `messageActionsBackground`（ECode 暂无消息选中交互）
- ❌ `useBriefLayout` 模式切换（ECode 暂无 brief 布局）
- ❌ macOS `⏺`（U+23FA）平台分支（统一用 `●` U+25CF）

---

## 附录 A：CC 与 ECode 视觉对照速查

| 元素 | CC | ECode（推荐方案） | 差异原因 |
|------|-----|------------------|---------|
| 用户消息 | 整行 bg `rgb(55,55,55)`，无前缀 | 整行 bg `#313244`，无前缀 | 完全对齐 |
| 助手消息 | `●` 圆点，颜色 `text`（灰） | `●` 圆点，颜色 `T.brand`（青） | ECode 保留品牌色识别度 |
| 助手圆点占位 | `minWidth=2` + `NoSelect` | `paddingLeft=1` 简化 | 标准 ink 无 NoSelect，paddingLeft 已够 |
| 工具结果 | `⎿  ` dimColor | `↳`（保留）/ `⎿`（可选） | 非核心，当前可用 |
| 输入光标 | 反色块状（invert video） | `▋` 块状闪烁 | 标准 ink 限制，块状闪烁更易实现 |
| Spinner | 星号家族 `· ✢ ✳ ✶ ✻ ✽` 往返 12 帧 | 同 CC | 完全对齐 |
| Spinner 帧速 | 200ms（思考）/ 50ms（请求）自适应 | 120ms 统一 | 简化，自适应留 P2 |
| Logo 闪光 | HSL 色相旋转 `✻` | 不做 | YAGNI，依赖 fork hook |
| Shimmer 输入 | useAnimationFrame 50ms | 不做 | YAGNI，依赖 fork hook |

---

## 附录 B：实施顺序建议

按 TDD 节奏 + 优先级分批：

1. **P0 第一批**（视觉核心）：theme.ts tokens + use-blink.ts + chat-view 用户/助手消息 + input-bar 光标
2. **P0 验收**：跑 `npx vitest run tests/ui/` 全绿 + 人工视觉检视
3. **P1 第二批**（动效增强）：spinner.tsx 星号家族 + input-bar disabled spinner
4. **P1 验收**：人工视觉检视 + 边界场景测试
5. **P2 可选**：工具消息 `⎿` + 减少动效兜底

---

**文档版本**：v1.0
**作者**：调研 + 设计（参考 Claude Code 源码）
**评审状态**：待用户确认后落地
