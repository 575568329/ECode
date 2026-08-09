// ActivityIndicator —— 统一活动指示器（loading 收口）。
// 把原本散落在 ChatView 动态区四态（thinking loader / streamingText 旁 / ToolRunning / pendingReadSearch）
// 各自实现的 spinner 收口成单一组件：动态区首行常驻，isRunning 期间任意子阶段都有 ◆+Spinner+状态文案。
//
// 根因修复：loading 是横切关注点，散落实现"漏一个态就消失"（曾发生 pendingReadSearch 漏 spinner bug）。
// 各态只声明 phase，渲染层单一来源 → 结构上不可能漏 spinner。附带收益：spinner setInterval 由最坏 N+2 降到 1。
import React from 'react';
import { Box, Text } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { Spinner } from './spinner.js';
import { summarizeGroup } from './read-search-group.js';
import type { DisplayMessage } from './types.js';

/** 当前活动阶段（idle = null，不渲染）。优先级见 deriveActivity。 */
export type ActivityPhase =
  | { kind: 'compacting' }               // /compact 压缩中（busy=compacting，最高优先级，压过 thinking）
  | { kind: 'tools'; count: number }     // 运行中工具（activeTools.count，并行工具合并计数）
  | { kind: 'replying' }                 // 流式吐字中（streamingText 非空）
  | { kind: 'reading'; summary: string } // 连续只读组挂起（pendingReadSearch，复用 summarizeGroup 摘要）
  | { kind: 'thinking' };                // 思考首 token 前（isRunning 且无其他态）

/**
 * 从 StreamState 派生当前活动阶段（纯函数，可单测）。
 * 优先级（高→低）：compacting > tools > replying > reading > thinking > null。
 * - compacting 最高：/compact 期间 isRunning=true 但语义是压缩，须压过 thinking，否则误显"思考中"。
 * - tools > reading：activeTools 与 pendingReadSearch 可共存（并行只读工具场景），运行中动作优先于已读暂存；
 *   reading 摘要等组破坏（text_delta/非只读 tool/completed）flush 进 Static 后仍可见，故暂存可接受。
 */
/** deriveActivity 依赖的状态子集（窄接口，解耦 StreamState/UseAgentStreamReturn 具体类型；
 *  生产由 chat-view 传 UseAgentStreamReturn，单测构造同形对象）。 */
export interface ActivityState {
  isCompacting: boolean;
  isRunning: boolean;
  streamingText: string | null;
  /** 只读 length（并行工具计数）；元素类型无关，故 unknown。 */
  activeTools: readonly unknown[];
  pendingReadSearch: DisplayMessage[];
}

export function deriveActivity(state: ActivityState): ActivityPhase | null {
  if (state.isCompacting) return { kind: 'compacting' };
  if (state.activeTools.length > 0) return { kind: 'tools', count: state.activeTools.length };
  if (state.streamingText) return { kind: 'replying' };
  if (state.pendingReadSearch.length > 0) {
    // 复用 read-search-group 的合并摘要（与延迟冻结 flush 进 Static 的 tool_group 摘要同源，单一规则）。
    const names = state.pendingReadSearch
      .filter((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool')
      .map((t) => ({ name: t.name }));
    return { kind: 'reading', summary: summarizeGroup(names) };
  }
  if (state.isRunning) return { kind: 'thinking' };
  return null;
}

/** phase → 文案。thinking/reading 文案须与 chat-view.test.tsx 断言严格匹配。 */
function phaseText(phase: ActivityPhase): string {
  switch (phase.kind) {
    case 'compacting':
      return '压缩中';
    case 'tools':
      return `运行 ${phase.count} 个工具`;
    case 'replying':
      return '回复中';
    case 'reading':
      return `· · · ${phase.summary} …`;
    case 'thinking':
      return '思考中';
  }
}

interface ActivityIndicatorProps {
  phase: ActivityPhase | null;
}

/** 统一活动指示器：◆ + Spinner + 状态文案。idle（null）不渲染。 */
export function ActivityIndicator({ phase }: ActivityIndicatorProps): React.ReactElement | null {
  if (!phase) return null;
  return (
    <Box>
      <Text color={T.brand} bold>{SYMBOLS.brand} </Text>
      <Spinner />
      <Text color={T.muted}> {phaseText(phase)}</Text>
    </Box>
  );
}
