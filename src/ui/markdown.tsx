// MarkdownRenderer —— 流式纯文本 / 完成后 marked + cli-highlight full render（spec §5.6）。
// 为什么不做 prefix-cache 流式 markdown：React.memo 已天然隔离稳定段落，手写边界探测过度设计。
import React from 'react';
import { Text, Box } from 'ink';
import { marked } from 'marked';
import type { Token, TokensList, Tokens } from 'marked';
import { highlight } from 'cli-highlight';
import { T } from './theme.js';

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
          nodes.push(
            <Text key={`${key}-${j}`}>
              <Text color={T.user}>• </Text>
              {renderInline(item.tokens ?? [], `${key}-${j}`)}
            </Text>,
          );
        });
        break;
      }
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

export function MarkdownRenderer({ text, streaming = false }: MarkdownRendererProps): React.ReactElement {
  if (streaming) {
    return <Text>{text}</Text>;
  }
  const parsed = marked.lexer(text);
  return <Box flexDirection="column">{renderTokens(parsed, 'md')}</Box>;
}
