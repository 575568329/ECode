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
import type { UseAgentStreamReturn } from './use-agent-stream.js';
import type { DisplayMessage } from './types.js';

/** pendingReadSearch 收窄到 tool 取 name 供合并摘要（reducer 保证只挂 kind:tool）。 */
function pendingToolNames(msgs: DisplayMessage[]): { name: string }[] {
  return msgs
    .filter((m): m is Extract<DisplayMessage, { kind: 'tool' }> => m.kind === 'tool')
    .map((t) => ({ name: t.name }));
}

/** 单条已完成消息 → React 节点（供 <Static>）。 */
function renderCompleted(msg: DisplayMessage): React.ReactNode {
  switch (msg.kind) {
    case 'user':
      // 角色区分：› 前缀 + 浅背景气泡（userBg），去"你"字（对齐 CC 气泡风格）。
      // 背景在多数终端整行渲染；长文本不稳时可降级首行背景（ui-preview 验证）。
      return (
        <Box marginTop={1} paddingLeft={1} backgroundColor={T.userBg}>
          <Text color={T.user} bold>{SYMBOLS.pointer} </Text>
          <Text>{msg.text}</Text>
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
          <ToolDone name={msg.name} content={msg.content} isError={msg.isError} input={msg.input} />
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

      {/* 动态区：流式文本 + 运行中工具 + 挂起的只读折叠组（延迟冻结） */}
      {(state.streamingText || state.activeTools.length > 0 || state.pendingReadSearch.length > 0) && (
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
          {/* 挂起的连续只读组：实时合并摘要（muted 灰 + ··· 进行中感），组破坏时 flush 进 Static */}
          {state.pendingReadSearch.length > 0 ? (
            <Text color={T.muted}>· · · {summarizeGroup(pendingToolNames(state.pendingReadSearch))} …</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
