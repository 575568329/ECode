// TodoPanel —— 常驻任务清单面板（消息队列与交互重做方案 §6）。
// 位置：InputBar 上方（QueuedMessages 之上）。数据源 = state.todos（UI 派生自 todo_write 工具输入）。
//
// 渲染策略：
//   - in_progress + pending 全显示（◾/◻ 符号）；in_progress 用品牌色 + activeForm 优先
//   - completed 折叠为「✓ N 已完成」单行（不逐条占行，控住面板高度）
//   - 空列表不渲染（不占位）
//   - in_progress 排最前（当前焦点），pending 次之
import React from 'react';
import { Box, Text } from 'ink';
import { T, SYMBOLS } from './theme.js';
import type { TodoItem } from '../tools/todo.js';

interface TodoPanelProps {
  todos: TodoItem[];
}

/** 状态排序权重：进行中靠前（当前焦点），待办次之，已完成折叠不参与排序。 */
const STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

/** 面板最多直显的 active 条数（§7.4 防顶屏：header 1 + active 6 + completed 1 ≈ 8 行上限）。 */
const MAX_ACTIVE = 6;

export function TodoPanel({ todos }: TodoPanelProps): React.ReactElement | null {
  if (todos.length === 0) return null; // 空 → 不渲染（不占位）

  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos
    .filter((t) => t.status !== 'completed')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  // 全部完成 → 不渲染（清除「N/N ✓ N 已完成」占位，保持界面干净）。
  if (active.length === 0) return null;
  // 面板高度上限（§7.4 防顶屏）：active 超 MAX_ACTIVE 只显前 N 条（排序后 in_progress 靠前优先保留），
  // 余下折叠为「… +M 条待办」。completed 已单行折叠，active 是唯一可能膨胀的部分。
  const shown = active.slice(0, MAX_ACTIVE);
  const hiddenCount = active.length - shown.length;

  return (
    <Box flexDirection="column">
      {/* 标题缩进2格对齐子项内容列：子项「符号+空格」占首2列、正文落列2，
          标题同样落列2，与任务正文、底部「… 条」「N 已完成」文字列共线（根治标题顶格与正文错位）。 */}
      <Text color={T.muted}>  待办 ({done}/{todos.length})</Text>
      {/* key 用 index：todos 是整表替换的临时派生列表，无稳定 id；纯展示无内部状态，index 安全。 */}
      {shown.map((t, i) => (
        <Box key={i}>
          <Text color={t.status === 'in_progress' ? T.brand : T.muted}>
            {t.status === 'in_progress' ? SYMBOLS.todoProgress : SYMBOLS.todoPending}{' '}
          </Text>
          <Text color={t.status === 'in_progress' ? T.thinking : T.muted}>
            {t.activeForm ?? t.content}
          </Text>
        </Box>
      ))}
      {hiddenCount > 0 ? (
        <Text color={T.muted}>  … +{hiddenCount} 条待办</Text>
      ) : null}
      {done > 0 ? (
        <Box>
          <Text color={T.success}>{SYMBOLS.success} </Text>
          <Text color={T.muted}>{done} 已完成</Text>
        </Box>
      ) : null}
    </Box>
  );
}
