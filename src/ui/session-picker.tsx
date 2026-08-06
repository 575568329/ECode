// SessionPicker —— /resume 会话选择器（方向 C，详设 docs/20260806210000_历史会话切换-详设.md §3.2/§3.3）。
// Modal 形态（App 用三元前置 resumeOpen 替换 InputBar），自带 useInput：
//   ↑↓ 循环导航（首项↑跳末项，对齐 CC use-select-navigation）/ Enter 载入 / Esc 取消（对齐 A/E）。
// 复用 PickerList（twoLine 两行制，对齐 CC LogSelector）。
// 列表项：标题(task 截断/无标题) + metadata(相对时间·模型·N轮)。
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { T } from './theme.js';
import { PickerList, type PickerItem } from './picker-list.js';
import { formatRelativeTimeAgo } from './format-time.js';
import { shortSessionId } from './format-session.js';
import type { ECodeSessionSummary } from '../session.js';

interface SessionPickerProps {
  /** 已过滤当前会话（App 层 filterResumableSessions 等价），且非空（空态在命令分支拦截）。 */
  sessions: ECodeSessionSummary[];
  onConfirm: (id: string) => void;
  onCancel: () => void;
}

const TASK_MAX = 40;
const PICKER_MAX_ITEMS = 5;

export function SessionPicker({ sessions, onConfirm, onCancel }: SessionPickerProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const len = sessions.length;

  // 会话列表变化（重开 picker）→ 选中重置首项
  useEffect(() => {
    setIndex(0);
  }, [sessions]);

  // clamp 防越界（sessions 变少时兜底）
  const safeIndex = len === 0 ? 0 : Math.min(index, len - 1);

  useInput((_input, key) => {
    if (len === 0) return;
    if (key.upArrow) {
      setIndex((i) => (i - 1 + len) % len); // 循环：首项↑跳末项（对齐 CC）
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % len);
      return;
    }
    if (key.return) {
      onConfirm(sessions[safeIndex].id);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  const items: PickerItem[] = sessions.map((s) => ({
    name: s.task.slice(0, TASK_MAX) || '(无标题)',
    description: `${formatRelativeTimeAgo(s.updatedAt, Date.now())} · ${s.model} · ${s.stats.rounds}轮 · ${shortSessionId(s.id)}`,
  }));

  return (
    <Box flexDirection="column">
      <Text color={T.muted}>恢复会话{len > PICKER_MAX_ITEMS ? `（共 ${len} 个）` : ''}</Text>
      <PickerList
        items={items}
        selectedIndex={safeIndex}
        maxItems={PICKER_MAX_ITEMS}
        prefix=""
        twoLine
        hint="↑↓ 选择 · enter 切换 · esc 取消"
      />
    </Box>
  );
}
