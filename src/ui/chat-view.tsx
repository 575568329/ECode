// ChatView —— <Static> 冻结历史 + 动态区（spec §3.2 / §4.1）。
// <Static items={completedMessages}>：Ink 把已完成项写入 stdout 一次后不再 diff（O(n)→O(1)）。
// 动态区：streamingText（流式纯文本）+ activeTools（运行中工具）。
import React from 'react';
import { Static, Box, Text } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { MarkdownRenderer } from './markdown.js';
import { ToolRunning, ToolDone, InlineTool, summarizeArg } from './tool-panel.js';
import { summarizeGroup } from './read-search-group.js';
import { leftBorder } from './borders.js';
import { ActivityIndicator, deriveActivity } from './activity-indicator.js';
import type { UseAgentStreamReturn } from './use-agent-stream.js';
import type { DisplayMessage } from './types.js';

/** 单条已完成消息 → React 节点（供 <Static>）。 */
function renderCompleted(msg: DisplayMessage): React.ReactNode {
  switch (msg.kind) {
    case 'user':
      return (
        <Box marginTop={1} paddingLeft={1} backgroundColor={T.userBg}>
          <Text color={T.user} bold>{SYMBOLS.pointer} </Text>
          <Text>{msg.text}</Text>
          {msg.images && msg.images.length > 0 && (
            <Text color={T.muted}> {msg.images.length}张图片</Text>
          )}
        </Box>
      );
    case 'assistant':
      // ◆ 前缀 + brand 左竖线（角色区分），去"ECode"字。
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={T.brand} bold>{SYMBOLS.brand}</Text>
          <Box {...leftBorder} borderColor={T.brand} paddingLeft={1}>
            <MarkdownRenderer text={msg.text} />
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box paddingLeft={4}>
          <ToolDone name={msg.name} content={msg.content} isError={msg.isError} input={msg.input} metadata={msg.metadata} />
        </Box>
      );
    case 'tool_group': {
      // 连续只读工具合并的折叠摘要行（延迟冻结 flush 进 Static）。
      // ✓/✗ + search + "Read N files · … (ctrl+o 展开)"；Ctrl+O pager 展开 tools 看完整内容。
      const hasError = msg.tools.some((t) => t.isError);
      return (
        <Box paddingLeft={4}>
          <InlineTool
            name="search"
            isError={hasError}
            summary={`${summarizeGroup(msg.tools)}  (ctrl+o 展开)`}
            arg=""
          />
        </Box>
      );
    }
    case 'warning':
      // 系统消息左边框（M3.5 Phase 1，§8.4-2.1）：与角色消息同构区分。
      return (
        <Box {...leftBorder} borderColor={T.warning} paddingLeft={1} marginTop={1}>
          <Text color={T.warning}>
            {SYMBOLS.warning} {msg.text}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box {...leftBorder} borderColor={T.error} paddingLeft={1} marginTop={1}>
          <Text color={T.error}>
            {SYMBOLS.error} {msg.text}
          </Text>
        </Box>
      );
  }
}

interface ChatViewProps {
  state: UseAgentStreamReturn;
}

export function ChatView({ state }: ChatViewProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* key=staticKey：switchSession/clear 时 ++ → <Static> 重 mount 重灌历史
          （<Static> append-only，替换 completedMessages 后须 key 变才重渲染，否则只追加新项）。 */}
      <Static key={state.staticKey} items={state.completedMessages}>
        {(msg) => <Box key={msg.id}>{renderCompleted(msg)}</Box>}
      </Static>

      {/* 动态区：流式文本 + 运行中工具 + 活动指示器（loading 常驻输入框正上方） */}
      {(state.isRunning || state.streamingText || state.activeTools.length > 0 || state.pendingReadSearch.length > 0) && (
        <Box flexDirection="column" paddingLeft={4}>
          {state.streamingText ? (
            <Box flexDirection="column">
              <Text color={T.brand} bold>{SYMBOLS.brand}</Text>
              <Box {...leftBorder} borderColor={T.brand} paddingLeft={1}>
                <MarkdownRenderer text={state.streamingText} streaming />
              </Box>
            </Box>
          ) : null}
          {state.activeTools.map((t) => (
            <ToolRunning key={t.id} name={t.name} arg={summarizeArg(t.name, t.input)} />
          ))}
          {/* 统一活动指示器：放在动态区最后，紧贴 InputBar 上方（用户期望 loading 常驻输入框正上方）。
              各态只声明 phase（deriveActivity 派生），渲染单一来源 → 结构上不会漏 spinner。 */}
          <ActivityIndicator phase={deriveActivity(state)} />
        </Box>
      )}
    </Box>
  );
}
