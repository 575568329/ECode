// ToolPanel —— 工具调用可视化（spec §5.5 / §8.4③④⑤）。
// 三态：running（spinner+计时）/ done-Inline（单行摘要）/ done-Block（左边框面板）。
// 折叠策略 per-tool 差异化（不一刀切）：
//   bash 成功=前3行 / bash 错误=前5行 / edit_file/write_file=完整 / read_file=只显行数 / grep=前3行
// 模式判定（Phase 2）：foldContent 折叠后 ≤1 行 → Inline；≥2 行 → Block。
import React from 'react';
import { Text, Box } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { Spinner } from './spinner.js';
import { leftBorder } from './borders.js';

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
  return (
    <Box>
      <Spinner color={T.brand} />
      <Text color={T.tool}> {SYMBOLS.tool} {name}</Text>
      {arg ? <Text color={T.muted}>({arg})</Text> : null}
    </Box>
  );
}

/** 折叠标签：空串=不显示折叠提示。 */
interface Folded {
  lines: string[];
  omitted: number;
  label: string;
}

/** 把多行内容按工具折叠策略裁剪。 */
function foldContent(name: string, isError: boolean, content: string): Folded {
  const all = content.split('\n');
  // read_file：只报行数，不显内容
  if (name === 'read_file') {
    return { lines: [`Read ${all.length} lines`], omitted: 0, label: '' };
  }
  // edit_file / write_file：完整不折叠（diff 是精华）
  if (name === 'edit_file' || name === 'write_file') {
    return { lines: all, omitted: 0, label: '' };
  }
  // bash：成功前 3 行，错误前 5 行（错误栈关键信息常在后面，多给几行）
  if (name === 'bash') {
    const head = isError ? 5 : 3;
    return all.length > head
      ? { lines: all.slice(0, head), omitted: all.length - head, label: 'more lines' }
      : { lines: all, omitted: 0, label: '' };
  }
  // grep：前 3 行匹配
  if (name === 'grep') {
    return all.length > 3
      ? { lines: all.slice(0, 3), omitted: all.length - 3, label: 'more matches' }
      : { lines: all, omitted: 0, label: '' };
  }
  // 其他：完整
  return { lines: all, omitted: 0, label: '' };
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

function InlineTool({ name, isError, summary, arg }: InlineToolProps): React.ReactElement {
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

interface BlockToolProps {
  name: string;
  isError: boolean;
  arg: string;
  lines: string[];
  omitted: number;
  label: string;
}

function BlockTool({ name, isError, arg, lines, omitted, label }: BlockToolProps): React.ReactElement {
  const icon = isError ? SYMBOLS.error : SYMBOLS.success;
  const iconColor = isError ? T.error : T.success;
  return (
    <Box
      {...leftBorder}
      borderColor={isError ? T.error : T.toolBorder}
      backgroundColor={T.toolBg}
      paddingLeft={1}
      flexDirection="column"
    >
      {/* 标题行：图标 + 工具名 + 参数 */}
      <Text>
        <Text color={iconColor}>{icon} </Text>
        <Text color={T.tool}>{name}</Text>
        {arg ? <Text color={T.muted}> ({arg})</Text> : null}
      </Text>
      {/* 内容行 */}
      {lines.map((l, i) => (
        <Text key={i}>
          <Text color={T.result}>{SYMBOLS.result} </Text>
          <Text>{l}</Text>
        </Text>
      ))}
      {omitted > 0 ? (
        <Text color={T.muted}>  ... {omitted} {label}</Text>
      ) : null}
    </Box>
  );
}

// ---- ToolDone：路由 Inline/Block ----

interface ToolDoneProps {
  name: string;
  content: string;
  isError: boolean;
  input?: Record<string, unknown>;
}

export function ToolDone({ name, content, isError, input }: ToolDoneProps): React.ReactElement {
  const folded = foldContent(name, isError, content);
  const arg = summarizeArg(name, input);
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
