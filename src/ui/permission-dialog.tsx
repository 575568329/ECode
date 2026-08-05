// PermissionDialog —— dangerous 工具审批弹窗（spec §5.4 / §8.4⑥）。
// Modal 替换（非叠加）InputBar：同一时间唯一活跃 useInput，避免多组件抢键。
// 425ms grace period（§7.1）：弹窗弹出时吸收前焦点残留按键，防 Enter 被误读为"允许"。
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { T, SYMBOLS } from './theme.js';
import type { PendingPermission } from './types.js';

const OPTIONS = ['allow', 'allow_always', 'deny'] as const;
export type Decision = (typeof OPTIONS)[number];

const LABELS: Record<Decision, string> = {
  allow: 'Yes',
  allow_always: "Yes, and don't ask again this session",
  deny: 'No',
};

/** grace period（ms）：挂载后这段时间内忽略一切按键，吸收残留 Enter。 */
const GRACE_MS = 425;

interface PermissionDialogProps {
  permission: PendingPermission;
  onResolve: (decision: Decision) => void;
}

export function PermissionDialog({ permission, onResolve }: PermissionDialogProps): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [armed, setArmed] = useState(false);

  // grace period：挂载后 425ms 才"激活"按键，期间忽略一切
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), GRACE_MS);
    return () => clearTimeout(id);
  }, []);

  useInput((_input, key) => {
    if (!armed) return; // grace period 内忽略
    if (key.escape) {
      onResolve('deny');
      return;
    }
    if (key.upArrow) {
      setSelected((s) => (s - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      onResolve(OPTIONS[selected]);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.permission} paddingX={2} paddingY={1}>
      <Text color={T.warning} bold>Permission Required</Text>
      <Text> </Text>
      <Text>{permission.toolName} wants to execute:</Text>
      <Text> </Text>
      <Box paddingLeft={2}>
        <Text color={T.tool}>{summarize(permission)}</Text>
      </Box>
      <Text> </Text>
      {OPTIONS.map((opt, i) => (
        <Text key={opt}>
          {i === selected ? (
            <Text color={T.accent}>{SYMBOLS.user} </Text>
          ) : (
            <Text color={T.muted}>  </Text>
          )}
          <Text bold={i === selected}>{i + 1}. {LABELS[opt]}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text color={T.muted}>↑↓ select · enter confirm · esc deny</Text>
    </Box>
  );
}

/** 把 permission 渲染成可读摘要（bash→命令，edit/write/read→路径，其他→JSON）。 */
function summarize(p: PendingPermission): string {
  if (p.toolName === 'bash') return String(p.input.command ?? '');
  if (['edit_file', 'write_file', 'read_file'].includes(p.toolName)) {
    return String(p.input.path ?? '');
  }
  return JSON.stringify(p.input);
}
