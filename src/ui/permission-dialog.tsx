// PermissionDialog —— dangerous 工具审批弹窗（spec §5.4 / §8.4⑥ / M4 阶段5）。
// Modal 替换（非叠加）InputBar：同一时间唯一活跃 useInput，避免多组件抢键。
// 425ms grace period（§7.1）：弹窗弹出时吸收前焦点残留按键，防 Enter 被误读为"允许"。
//
// 阶段5 三态确认流（phase 状态机）：
//   choose          三选项导航。allow→直接放行；allow_always→confirm-always；deny→reject-feedback；esc→快速 deny。
//   confirm-always  展示将永久放行的 pattern（防误点永久放行），y/enter 确认、n/esc 返回。
//   reject-feedback 可选拒绝原因输入框，回喂 LLM；enter 提交、esc 返回。
// 5c：bash 危险命令（rm -rf / git push -force 等）红字高亮（仅警告，不影响逻辑）。
// 5d：permission.reason（doom_loop）存在时顶部醒目提示。
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { T, SYMBOLS } from './theme.js';
import type { PendingPermission } from './types.js';
import { splitCompound, toAlwaysPattern } from '../permission/arity.js';
import { detectDangerousBash } from '../permission/dangerous-bash.js';

const OPTIONS = ['allow', 'allow_always', 'deny'] as const;
export type Decision = (typeof OPTIONS)[number];

const LABELS: Record<Decision, string> = {
  allow: 'Yes',
  allow_always: "Yes, and don't ask again this session",
  deny: 'No',
};

type Phase = 'choose' | 'confirm-always' | 'reject-feedback';

/** grace period（ms）：挂载后这段时间内忽略一切按键，吸收残留 Enter。 */
const GRACE_MS = 425;

interface PermissionDialogProps {
  permission: PendingPermission;
  /** 决策回调；deny 可携带可选 feedback（回喂 LLM）。 */
  onResolve: (decision: Decision, feedback?: string) => void;
}

export function PermissionDialog({ permission, onResolve }: PermissionDialogProps): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [armed, setArmed] = useState(false);
  const [phase, setPhase] = useState<Phase>('choose');
  const [feedback, setFeedback] = useState('');

  // grace period：挂载后 425ms 才"激活"按键，期间忽略一切
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), GRACE_MS);
    return () => clearTimeout(id);
  }, []);

  // 5c：bash 危险命令检测（仅警告）。
  const warnings =
    permission.toolName === 'bash' ? detectDangerousBash(String(permission.input.command ?? '')) : [];

  useInput((input, key) => {
    if (!armed) return; // grace period 内忽略
    if (phase === 'choose') {
      if (key.escape) {
        onResolve('deny'); // 快速拒绝（无反馈），用于"看一眼就关"
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
        const opt = OPTIONS[selected];
        if (opt === 'allow') onResolve('allow');
        else if (opt === 'allow_always') setPhase('confirm-always');
        else setPhase('reject-feedback'); // deny：进反馈输入
      }
      return;
    }
    if (phase === 'confirm-always') {
      // n/esc 返回选择；y/enter 确认永久放行。
      if (key.escape || input === 'n' || input === 'N') {
        setPhase('choose');
        return;
      }
      if (key.return || input === 'y' || input === 'Y') {
        onResolve('allow_always');
      }
      return;
    }
    // reject-feedback：可编辑文本输入。
    if (key.escape) {
      setPhase('choose');
      return;
    }
    if (key.return) {
      const fb = feedback.trim();
      if (fb) onResolve('deny', fb);
      else onResolve('deny'); // 留空：无反馈直接拒绝（不传第二参数）
      return;
    }
    if (key.backspace || key.delete) {
      setFeedback((f) => f.slice(0, -1));
      return;
    }
    // 普通可打印字符（排除控制字符/转义序列/修饰键）。
    // 用 + 量词兼容多字符一次性写入（stdin.write('stop') 可能整段送达）。
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      /^[^\x00-\x1f\x7f]+$/.test(input)
    ) {
      setFeedback((f) => f + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.permission} paddingX={2} paddingY={1}>
      <Text color={T.warning} bold>
        Permission Required
      </Text>
      <Text> </Text>
      {/* 5d：doom_loop 等额外原因，顶部醒目提示 */}
      {permission.reason ? (
        <>
          <Text color={T.error} bold>
            ⚠ {permission.reason}
          </Text>
          <Text> </Text>
        </>
      ) : null}
      <Text>
        {permission.toolName} wants to execute:
      </Text>
      <Text> </Text>
      <Box paddingLeft={2}>
        <Text color={T.tool}>{summarize(permission)}</Text>
      </Box>
      {/* 5c：危险命令红字高亮 */}
      {warnings.length > 0 ? (
        <>
          <Text> </Text>
          {warnings.map((w, i) => (
            <Text key={i} color={T.error} bold>
              ⚠ {w}
            </Text>
          ))}
          <Text> </Text>
        </>
      ) : null}
      {phase === 'choose' ? (
        <>
          <Text> </Text>
          {OPTIONS.map((opt, i) => (
            <Text key={opt}>
              {i === selected ? (
                <Text color={T.accent}>
                  {SYMBOLS.user}{' '}
                </Text>
              ) : (
                <Text color={T.muted}>  </Text>
              )}
              <Text bold={i === selected}>
                {i + 1}. {LABELS[opt]}
              </Text>
            </Text>
          ))}
          <Text> </Text>
          <Text color={T.muted}>↑↓ select · enter confirm · esc deny</Text>
        </>
      ) : phase === 'confirm-always' ? (
        <>
          <Text> </Text>
          <Text color={T.warning}>将永久放行（本会话），匹配模式：</Text>
          <Box paddingLeft={2}>
            <Text color={T.tool} bold>
              {alwaysPreview(permission.toolName, permission.input)}
            </Text>
          </Box>
          <Text> </Text>
          <Text color={T.muted}>y/enter 确认放行 · n/esc 返回</Text>
        </>
      ) : (
        <>
          <Text> </Text>
          <Text color={T.warning}>拒绝原因（可选，将回喂 LLM）：</Text>
          <Box paddingLeft={2}>
            <Text color={feedback ? T.tool : T.muted}>
              {feedback || '（留空直接拒绝）'}
            </Text>
            <Text color={T.accent}>▏</Text>
          </Box>
          <Text> </Text>
          <Text color={T.muted}>输入反馈 · enter 确认拒绝 · esc 返回</Text>
        </>
      )}
    </Box>
  );
}

/** 把 permission 渲染成可读摘要（bash→命令，路径类工具→路径，move→源→目标，其他→JSON）。 */
function summarize(p: PendingPermission): string {
  if (p.toolName === 'bash') return String(p.input.command ?? '');
  if (p.toolName === 'move') {
    return `${p.input.source ?? ''} → ${p.input.destination ?? ''}`;
  }
  if (['edit_file', 'write_file', 'read_file', 'delete_file'].includes(p.toolName)) {
    return String(p.input.path ?? '');
  }
  return JSON.stringify(p.input);
}

/** allow_always 确认面板的 pattern 预览：bash 取每段归约 pattern，非 bash 取工具名粒度。 */
function alwaysPreview(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') {
    const cmd = String(input.command ?? '');
    const segs = splitCompound(cmd).map(toAlwaysPattern);
    return segs.length > 0 ? segs.join('  |  ') : '(空命令)';
  }
  return toolName;
}
