// MarkdownRenderer —— 流式纯文本 / 完成后 marked + cli-highlight full render（spec §5.6）。
// 为什么不做 prefix-cache 流式 markdown：React.memo 已天然隔离稳定段落，手写边界探测过度设计。
import React from 'react';
import { Text, Box } from 'ink';
import { marked } from 'marked';
import type { Token, TokensList, Tokens } from 'marked';
import { highlight } from 'cli-highlight';
import { T } from './theme.js';
import { displayWidth, padEndDisplay } from './display-width.js';

interface MarkdownRendererProps {
  text: string;
  /** true=流式中，纯文本输出；false=完成，marked 解析 + 高亮。 */
  streaming?: boolean;
}

// 配置 marked：返回结构化 token，自己渲染（不直接 to-string，便于着色）。
marked.setOptions({ gfm: true, breaks: false });

/** 把 marked token 树拍平成 React 节点数组。 */
function renderTokens(tokens: TokensList, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  tokens.forEach((tok, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (tok.type) {
      case 'heading':
        nodes.push(
          <Text key={key} bold color={T.brand}>
            {tok.text}
          </Text>,
        );
        break;
      case 'paragraph':
        nodes.push(<Text key={key}>{renderInline(tok.tokens ?? [], key)}</Text>);
        break;
      case 'code': {
        const code = tok.text;
        let displayed = code;
        try {
          displayed = highlight(code, { language: tok.lang || 'ts' });
        } catch {
          /* 解析失败保留原文 */
        }
        // cli-highlight 输出带 ANSI；ink 会按 ANSI 还原样式，原样塞进 <Text> 即可。
        nodes.push(
          <Box key={key} flexDirection="column">
            <Text>{displayed}</Text>
          </Box>,
        );
        break;
      }
      case 'list': {
        // marked 的 Token 联合含 Tokens.Generic（[index: string]: any），switch 收窄后
        // tok 仍残留 Generic 臂、使 tok.items 退化为 any；这里显式按 List['items'] 取用。
        const items = tok.items as Tokens.List['items'];
        items.forEach((item, j) => {
          // list_item.tokens 首层是 text/paragraph 容器，真 inline 在其 .tokens；
          // 直接 renderInline(item.tokens) 会命中 text 分支返回 tok.text（保留 ** 等标记 → 漏星号）。
          // 拍平：有 .tokens 的取它，否则原样（兼容纯 inline / loose list 多 paragraph）。
          const inline = (item.tokens ?? []).flatMap((it) => {
            const node = it as { tokens?: Token[] };
            return node.tokens ?? [it];
          });
          nodes.push(
            <Text key={`${key}-${j}`}>
              <Text color={T.user}>• </Text>
              {renderInline(inline, `${key}-${j}`)}
            </Text>,
          );
        });
        break;
      }
      case 'table':
        nodes.push(renderTable(tok as Tokens.Table, key));
        break;
      case 'space':
        nodes.push(<Text key={key}> </Text>);
        break;
      default:
        // 兜底：raw 文本
        nodes.push(<Text key={key}>{tok.raw}</Text>);
    }
  });
  return nodes;
}

/** 行内 token（bold/italic/codespan/link/text）渲染。 */
function renderInline(tokens: Token[], keyPrefix: string): React.ReactNode {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-i${i}`;
    if (tok.type === 'strong') return <Text key={key} bold>{tok.text}</Text>;
    if (tok.type === 'em') return <Text key={key} italic>{tok.text}</Text>;
    if (tok.type === 'codespan')
      return (
        <Text key={key} color={T.tool}>
          {tok.text}
        </Text>
      );
    if (tok.type === 'link') return <Text key={key} color={T.accent}>{tok.text}</Text>;
    if (tok.type === 'text') return <Text key={key}>{tok.text}</Text>;
    return <Text key={key}>{tok.raw}</Text>;
  });
}

/** 单元格 inline tokens → 纯文本（marked 的 TableCell.text 保留 ** 等标记，
 *  用 tokens 提纯 → 表格里 **粗体** 显示为「粗体」无星号；空 tokens 回退 .text）。 */
function cellToPlainText(cell: Tokens.TableCell): string {
  // marked 的 Token 联合里部分类型（如 Space）无 .text 字段，结构化转型安全访问。
  const t = (cell.tokens ?? [])
    .map((tk) => {
      const node = tk as { text?: string; raw?: string };
      return node.text ?? node.raw ?? '';
    })
    .join('');
  return t.length > 0 ? t : (cell.text ?? '');
}

/** 表格 → 对齐列 + │ 边框（表头粗体 + brand 色；数据行常规）。
 *  已知限制：padEnd 按 string.length 对齐，中日韩等宽字符显示宽 ≠ length → 轻微错位。 */
function renderTable(tok: Tokens.Table, key: string): React.ReactNode {
  const headerCells = tok.header.map(cellToPlainText);
  const rowsCells = tok.rows.map((r) => r.map(cellToPlainText));
  const colCount = headerCells.length;
  const allRows = [headerCells, ...rowsCells];
  // 列宽 = 该列所有单元格「显示宽度」最长者（padEndDisplay 按显示宽度补齐，保证 │ 对齐）。
  // 不能用 string.length：中文 length=2 占 2 终端列，padEnd 会补错 → │ 右移错位。
  const widths = Array.from({ length: colCount }, (_, ci) =>
    Math.max(...allRows.map((r) => displayWidth(r[ci] ?? ''))),
  );
  const renderRow = (cells: string[], rowKey: string, isHeader: boolean): React.ReactNode => (
    <Text key={rowKey}>
      <Text color={T.muted}>│ </Text>
      {cells.map((c, ci) => (
        <React.Fragment key={ci}>
          <Text bold={isHeader} color={isHeader ? T.brand : undefined}>
            {padEndDisplay(c, widths[ci])}
          </Text>
          {ci < colCount - 1 ? <Text color={T.muted}> │ </Text> : null}
        </React.Fragment>
      ))}
      <Text color={T.muted}> │</Text>
    </Text>
  );
  return (
    <Box key={key} flexDirection="column">
      {renderRow(headerCells, `${key}-h`, true)}
      {rowsCells.map((r, ri) => renderRow(r, `${key}-r${ri}`, false))}
    </Box>
  );
}

export function MarkdownRenderer({ text, streaming = false }: MarkdownRendererProps): React.ReactElement {
  if (streaming) {
    return <Text>{text}</Text>;
  }
  const parsed = marked.lexer(text);
  return <Box flexDirection="column">{renderTokens(parsed, 'md')}</Box>;
}
