// ChatView —— <Static> 冻结历史 + 动态区（spec §3.2 / §4.1）。
// <Static items={completedMessages}>：Ink 把已完成项写入 stdout 一次后不再 diff（O(n)→O(1)）。
// 动态区：streamingText（流式纯文本）+ activeTools（运行中工具）。
import React from 'react';
import { Static, Box, Text } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { MarkdownRenderer } from './markdown.js';
import { ToolRunning, ToolDone } from './tool-panel.js';
import type { UseAgentStreamReturn } from './use-agent-stream.js';
import type { DisplayMessage } from './types.js';

/** 单条已完成消息 → React 节点（供 <Static>）。 */
function renderCompleted(msg: DisplayMessage): React.ReactNode {
  switch (msg.kind) {
    case 'user':
      return (
        <Box flexDirection="column">
          <Text><Text color={T.user} bold>{SYMBOLS.user} 你</Text></Text>
          <Box paddingLeft={4}><Text color={T.muted}>{msg.text}</Text></Box>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Text><Text color={T.brand} bold>{SYMBOLS.brand} ECode</Text></Text>
          <Box paddingLeft={4}>
            <MarkdownRenderer text={msg.text} />
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box paddingLeft={4}>
          <ToolDone name={msg.name} content={msg.content} isError={msg.isError} />
        </Box>
      );
    case 'warning':
      return (
        <Text color={T.warning}>{SYMBOLS.warning} {msg.text}</Text>
      );
    case 'error':
      return (
        <Text color={T.error}>{SYMBOLS.error} {msg.text}</Text>
      );
  }
}

interface ChatViewProps {
  state: UseAgentStreamReturn;
}

export function ChatView({ state }: ChatViewProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={state.completedMessages}>
        {(msg) => <Box key={msg.id}>{renderCompleted(msg)}</Box>}
      </Static>

      {/* 动态区：流式文本 + 运行中工具 */}
      {(state.streamingText || state.activeTools.length > 0) && (
        <Box flexDirection="column" paddingLeft={4}>
          {state.streamingText ? (
            <Text>
              <Text color={T.brand} bold>{SYMBOLS.brand} ECode</Text>
              {'\n'}
              <MarkdownRenderer text={state.streamingText} streaming />
            </Text>
          ) : null}
          {state.activeTools.map((t) => (
            <ToolRunning key={t.id} name={t.name} />
          ))}
        </Box>
      )}
    </Box>
  );
}
