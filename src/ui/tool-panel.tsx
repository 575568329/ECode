// ToolPanel —— 工具调用可视化（spec §5.5 / §8.4③④⑤）。
// 三态：running（spinner+计时）/ done-Inline（单行摘要）/ done-Block（左边框面板）。
// 折叠策略：声明式策略表 FOLD_STRATEGIES + 统一 fold() 函数（不再 per-tool if-else）。
//   summary=完全折叠成摘要行 / head=截断前 N 行 / full=不折叠。
//   新工具只需加一行声明；未知工具兜底 head(3)（对标 CC 统一 3 行）。
//   Folded.folded 标志供 format-transcript 判断 Ctrl+O 展开（单一规则源）。
// 模式判定（Phase 2）：foldContent 折叠后 ≤1 行 → Inline；≥2 行 → Block。
import React from 'react';
import { Text, Box } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { leftBorder } from './borders.js';
import type { ToolResultMetadata } from '../tools/types.js';

/** 计时显示占位：实时秒数留给 M4（useEffect+setInterval），本任务非关键视觉糖。 */
function useElapsed(startedAt: number): string {
  void startedAt;
  return '';
}

interface ToolRunningProps {
  name: string;
  arg?: string;
}

export function ToolRunning({ name, arg }: ToolRunningProps): React.ReactElement {
  // 转圈归统一 ActivityIndicator（消除双闪）；此处只留工具名+参数静态详情。
  // 工具名+▸ 走 muted 灰，完成后(ToolDone)才亮起(✓ 绿/黄名)。
  return (
    <Box>
      <Text color={T.muted}> {SYMBOLS.tool} {name}</Text>
      {arg ? <Text color={T.muted}>({arg})</Text> : null}
    </Box>
  );
}

// ---- 折叠策略表（声明式，新工具加一行即可） ----

/** 折叠策略三态。
 *  summary: 完全折叠成 "<verb> <count> <unit>" 单行摘要（≥2 条目时；单条/空原样）。
 *  head:    截断前 N 行 + "more" 提示（对标 CC 统一 3 行，不区分 error/success）。
 *  full:    不折叠（diff 等精华内容）。 */
type FoldStrategy =
  | { mode: 'summary'; verb: string; unit: string; minEntries?: number }
  | { mode: 'head'; lines: number; label: string }
  | { mode: 'full' };

/** 默认兜底：未知工具走 head(3)（对标 CC terminal.ts MAX_LINES_TO_SHOW=3）。 */
const DEFAULT_STRATEGY: FoldStrategy = { mode: 'head', lines: 3, label: 'more lines' };

/**
 * 策略表：每工具一行声明。新工具（含 MCP）加一行即可获得折叠行为。
 * 显式 full = opt-out（如 edit_file diff 精华不折叠）。
 *
 * 参考：
 *   CC: Tool 接口多态 renderToolResultMessage + terminal.ts 统一 3 行截断。
 *   opencode: 各组件硬编码 maxLines（GenericTool=3, Shell=10），无统一表。
 *   ECode 取折中：声明式策略表 + 统一 fold() 函数，比 CC 轻量、比 opencode 集中。
 */
const FOLD_STRATEGIES: Record<string, FoldStrategy> = {
  // 摘要类：列举型工具，内容量大但用户只关心数量，详情去 Ctrl+O 看
  // minEntries: 触发摘要折叠的最小条目数（默认 2，避免 "Found 1 files" 尴尬）。
  // read_file 设 1：即使 1 行也摘要（主界面 "Read 1 lines" 不显内容，需 Ctrl+O 看）。
  read_file:      { mode: 'summary', verb: 'Read',   unit: 'lines', minEntries: 1 },
  glob:           { mode: 'summary', verb: 'Found',  unit: 'files' },
  ls:             { mode: 'summary', verb: 'Listed', unit: 'entries' },
  list_directory: { mode: 'summary', verb: 'Listed', unit: 'entries' },

  // 截断类：输出型工具，前几行有价值，后面截断
  grep:       { mode: 'head', lines: 3,  label: 'of N matches' },  // N 运行时替换为总命中数
  bash:       { mode: 'head', lines: 3,  label: 'more lines' },
  write_file: { mode: 'head', lines: 10, label: 'more lines' },   // 对齐 CC write 阈值

  // 不折叠：变更型工具，每行都是精华
  edit_file: { mode: 'full' },
};

/** 折叠结果。folded 标志供 format-transcript 判断 Ctrl+O 展开（单一规则源）。 */
export interface Folded {
  lines: string[];
  omitted: number;
  label: string;
  /** 内容是否被折叠（summary ≥2 条目 / head 有 omitted → true）。format-transcript 读此字段。 */
  folded: boolean;
}

/** 根据策略表查找工具策略（未知工具走 DEFAULT_STRATEGY兜底）。 */
function getStrategy(name: string): FoldStrategy {
  return FOLD_STRATEGIES[name] ?? DEFAULT_STRATEGY;
}

/** 统一折叠函数：策略驱动，不再 per-tool if-else。
 *  label 中的 'N' 占位符在 head 模式下替换为实际总行数（如 grep 的 "of 5 matches"）。
 *  导出：format-transcript 复用 folded 判定是否进 less 展开（单一规则源）。 */
export function foldContent(name: string, isError: boolean, content: string): Folded {
  // 去尾部换行：输出常带尾 \n，split 会产出末尾空串 → 渲染空 ↳ 行（噪声）。
  const all = content.replace(/\n+$/, '').split('\n');
  const strategy = getStrategy(name);

  switch (strategy.mode) {
    case 'summary': {
      // 条目 ≥ minEntries 时折叠成 "<verb> <count> <unit>" 单行；否则原样。
      const min = strategy.minEntries ?? 2;
      if (all.length >= min) {
        return { lines: [`${strategy.verb} ${all.length} ${strategy.unit}`], omitted: 0, label: '', folded: true };
      }
      return { lines: all, omitted: 0, label: '', folded: false };
    }
    case 'head': {
      const head = strategy.lines;
      if (all.length > head) {
        const label = strategy.label.replace('N', String(all.length));
        return { lines: all.slice(0, head), omitted: all.length - head, label, folded: true };
      }
      return { lines: all, omitted: 0, label: '', folded: false };
    }
    case 'full': {
      // full 本意「成功内容是精华不截断」（edit_file diff 等）；但失败时 content 常是诊断长文
      // （edit_file 失败回喂整文件带行号 ≤50K，edit-file.ts:33-45），仍 full 会刷屏 → 失败降级 head(3)。
      if (!isError) return { lines: all, omitted: 0, label: '', folded: false };
      const head = 3;
      if (all.length > head) {
        return { lines: all.slice(0, head), omitted: all.length - head, label: 'more lines', folded: true };
      }
      return { lines: all, omitted: 0, label: '', folded: false };
    }
  }
}

/** 工具展示模式（Phase 2）。由 foldContent 折叠行数驱动，单一规则源。 */
type ToolMode = 'inline' | 'block';

/** 判定工具展示模式：≤1 行 → Inline；≥2 行 → Block。 */
function decideToolMode(name: string, isError: boolean, content: string): ToolMode {
  const { lines } = foldContent(name, isError, content);
  return lines.length <= 1 ? 'inline' : 'block';
}

// ---- InlineTool：单行摘要，无边框 ----

interface InlineToolProps {
  name: string;
  isError: boolean;
  summary: string;
  arg: string;
}

export function InlineTool({ name, isError, summary, arg }: InlineToolProps): React.ReactElement {
  const icon = isError ? SYMBOLS.error : SYMBOLS.success;
  const iconColor = isError ? T.error : T.success;
  const parts: React.ReactNode[] = [
    <Text key="icon" color={iconColor}>{icon} </Text>,
    <Text key="name" color={T.tool}>{name}</Text>,
  ];
  if (arg) {
    parts.push(<Text key="sep" color={T.muted}> · </Text>);
    parts.push(<Text key="arg" color={T.muted}>{arg}</Text>);
  }
  parts.push(<Text key="sep2" color={T.muted}> · </Text>);
  parts.push(<Text key="summary">{summary}</Text>);
  return <Text>{parts}</Text>;
}

// ---- BlockTool：左边框面板 + 深色背景 ----

/** 子代理路由来源 → 中文标签（供 Task 气泡 via-line 标注，§16.5）。
 *  default 不在表内 → 不显示 via-line（避免噪声，default = 等于没路由）。 */
const SOURCE_LABELS: Record<string, string> = {
  persona: '人设',
  complexity: '复杂度路由',
  rule: '路由规则',
};

interface BlockToolProps {
  name: string;
  isError: boolean;
  arg: string;
  lines: string[];
  omitted: number;
  label: string;
  /** 子代理路由元数据（仅 Task 工具填充）；存在且来源非 default 时渲染 via-line。 */
  metadata?: ToolResultMetadata;
}

function BlockTool({ name, isError, arg, lines, omitted, label, metadata }: BlockToolProps): React.ReactElement {
  const icon = isError ? SYMBOLS.error : SYMBOLS.success;
  const iconColor = isError ? T.error : T.success;
  const sourceLabel = metadata?.routingSource ? SOURCE_LABELS[metadata.routingSource] : undefined;
  return (
    <Box
      {...leftBorder}
      borderColor={isError ? T.error : T.toolBorder}
      paddingLeft={1}
      flexDirection="column"
    >
      {/* 标题行：图标 + 工具名 + 参数 */}
      <Text>
        <Text color={iconColor}>{icon} </Text>
        <Text color={T.tool}>{name}</Text>
        {arg ? <Text color={T.muted}> ({arg})</Text> : null}
      </Text>
      {/* via-line：子代理用的模型 + 路由来源（仅 Task 且来源非 default 时显示，§16.5） */}
      {sourceLabel ? (
        <Text color={T.muted}>  via {sourceLabel} → {metadata?.model}</Text>
      ) : null}
      {/* 内容行 */}
      {lines.map((l, i) => (
        <Text key={i}>
          <Text color={T.result}>{SYMBOLS.result} </Text>
          <Text>{l}</Text>
        </Text>
      ))}
      {omitted > 0 ? (
        <Text color={T.muted}>  … +{omitted} {label} (ctrl+o 展开)</Text>
      ) : null}
    </Box>
  );
}

// ---- EditFileDiff：edit_file 成功的 +/- 着色 diff 渲染（对标 CC StructuredDiff） ----

interface EditFileDiffProps {
  path: string;
  content: string;
}

/**
 * edit_file 成功结果的 diff 着色渲染（对标 CC StructuredDiff + FileEditToolUpdatedMessage）。
 * content = 「回执\n\nunified diff」：逐行按行首字符着色——
 *   '+'（非 '+++' 文件头）→ diffAdded 绿；'-'（非 '---'）→ diffRemoved 红；
 *   ' '（context）→ muted；其他（回执 / @@ / 文件头）默认色。
 * 顶部摘要 Added N / Removed M（统计 + / - 行数，复用 theme 预留的 diffAdded/diffRemoved token）。
 */
function EditFileDiff({ path, content }: EditFileDiffProps): React.ReactElement {
  const lines = content.replace(/\n+$/, '').split('\n');
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return (
    <Box {...leftBorder} borderColor={T.toolBorder} paddingLeft={1} flexDirection="column">
      <Text>
        <Text color={T.success}>{SYMBOLS.success} </Text>
        <Text color={T.tool}>edit_file</Text>
        <Text color={T.muted}> ({path}) · +</Text>
        <Text color={T.diffAdded}>{added}</Text>
        <Text color={T.muted}> / -</Text>
        <Text color={T.diffRemoved}>{removed}</Text>
      </Text>
      {lines.map((line, i) => {
        if (line.startsWith('+') && !line.startsWith('+++'))
          return <Text key={i} color={T.diffAdded}>{line}</Text>;
        if (line.startsWith('-') && !line.startsWith('---'))
          return <Text key={i} color={T.diffRemoved}>{line}</Text>;
        if (line.startsWith(' ')) return <Text key={i} color={T.muted}>{line}</Text>;
        return <Text key={i}>{line}</Text>;
      })}
    </Box>
  );
}

// ---- ToolDone：路由 Inline/Block ----

interface ToolDoneProps {
  name: string;
  content: string;
  isError: boolean;
  input?: Record<string, unknown>;
  metadata?: ToolResultMetadata;
}

export function ToolDone({ name, content, isError, input, metadata }: ToolDoneProps): React.ReactElement {
  const arg = summarizeArg(name, input);
  // edit_file 成功 → 渲染 +/- 着色 diff（成功 content 含 unified diff，对标 CC StructuredDiff）。
  // 失败仍走下方 foldContent（A2：isError 降级 head 折叠，避免整文件带行号刷屏）。
  if (name === 'edit_file' && !isError) {
    return <EditFileDiff path={arg} content={content} />;
  }
  const folded = foldContent(name, isError, content);
  const mode = decideToolMode(name, isError, content);

  if (mode === 'inline') {
    return (
      <InlineTool
        name={name}
        isError={isError}
        summary={folded.lines[0]}
        arg={arg}
      />
    );
  }
  return (
    <BlockTool
      name={name}
      isError={isError}
      arg={arg}
      lines={folded.lines}
      omitted={folded.omitted}
      label={folded.label}
      metadata={metadata}
    />
  );
}

/** 生成工具参数摘要（显示在工具名后括号/圆点分隔里）。 */
export function summarizeArg(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  if (name === 'bash') return String(input.command ?? '');
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file')
    return String(input.path ?? '');
  if (name === 'grep') return `"${input.pattern ?? ''}"`;
  if (name === 'glob') return String(input.pattern ?? '');
  return '';
}

// 兜底导出（满足 noUnusedLocals 并标记意图：计时显示留 M4 加 setInterval 实现）
void useElapsed;
