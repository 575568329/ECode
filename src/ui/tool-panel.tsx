// ToolPanel —— 工具调用可视化（spec §5.5 / §8.4③④⑤）。
// 三态：running（spinner+计时）/ done（↳ ✓ 摘要）/ error（↳ ✗ 摘要）。
// 折叠策略 per-tool 差异化（不一刀切）：
//   bash 成功=前3行 / bash 错误=前5行 / edit_file/write_file=完整 / read_file=只显行数 / grep=前3行
import React from 'react';
import { Text, Box } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { Spinner } from './spinner.js';

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

interface ToolDoneProps {
  name: string;
  content: string;
  isError: boolean;
  input?: Record<string, unknown>;
}

export function ToolDone({ name, content, isError, input }: ToolDoneProps): React.ReactElement {
  const { lines, omitted, label } = foldContent(name, isError, content);
  const arg = summarizeArg(name, input);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={T.tool}>{SYMBOLS.tool} {name}</Text>
        {arg ? <Text color={T.muted}>({arg})</Text> : null}
      </Text>
      <Text>
        <Text color={T.result}>{SYMBOLS.result} </Text>
        {isError ? (
          <Text color={T.error}>{SYMBOLS.error} </Text>
        ) : (
          <Text color={T.success}>{SYMBOLS.success} </Text>
        )}
        <Text>{lines[0]}</Text>
      </Text>
      {lines.slice(1).map((l, i) => (
        <Text key={i} color={T.muted}>    {l}</Text>
      ))}
      {omitted > 0 ? (
        <Text color={T.muted}>    ... {omitted} {label}</Text>
      ) : null}
    </Box>
  );
}

/** 生成工具参数摘要（显示在工具名后括号里）。 */
function summarizeArg(name: string, input?: Record<string, unknown>): string {
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
