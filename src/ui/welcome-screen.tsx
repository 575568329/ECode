// WelcomeScreen —— 双栏圆角欢迎面板（spec §8.4①⑩）。
// completedMessages 为空时显示；首次 submit 后被 ChatView 替代。
// 不放历史会话列表（噪声——会话恢复走 /resume /sessions）。
import React from 'react';
import { Box, Text } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { Logo } from './logo.js';

export interface LoadStatus {
  claudeMd: { ok: boolean; lines: number } | null;
  provider: { ok: boolean; label: string } | null;
}

interface WelcomeScreenProps {
  version: string;
  loadStatus: LoadStatus;
  cwd: string;
  narrow?: boolean;
}

export function WelcomeScreen({ version, loadStatus, cwd, narrow = false }: WelcomeScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={T.brand} bold>  ─── ECode v{version} ───</Text>
      <Box
        flexDirection="row"
        gap={narrow ? 0 : 6}
        borderStyle="round"
        borderColor={T.border}
        paddingX={narrow ? 1 : 2}
        paddingY={1}
      >
        <Box flexDirection="column" width={narrow ? undefined : 34}>
          <Logo />
          <Text> </Text>
          <Text color={T.brand} bold>Welcome!</Text>
          <Text> </Text>
          {loadStatus.claudeMd ? (
            <Text>
              <Text color={T.success}>{SYMBOLS.success}</Text> Loaded CLAUDE.md (project, {loadStatus.claudeMd.lines} lines)
            </Text>
          ) : null}
          {loadStatus.provider ? (
            <Text>
              <Text color={T.success}>{SYMBOLS.success}</Text> {loadStatus.provider.label} {loadStatus.provider.ok ? '(connected)' : '(offline)'}
            </Text>
          ) : null}
          <Text>
            <Text color={T.muted}>cwd </Text>
            {cwd} (git)
          </Text>
        </Box>
        {narrow ? null : (
          <Box flexDirection="column" flexGrow={1}>
            <Text color={T.brand} bold>Commands</Text>
            <Text color={T.border}>───────────</Text>
            <Text>
              <Text color={T.user}>/help</Text>    命令帮助
            </Text>
            <Text>
              <Text color={T.user}>/model</Text>   切换模型
            </Text>
            <Text>
              <Text color={T.user}>/clear</Text>   清空对话
            </Text>
            <Text> </Text>
            <Text color={T.brand} bold>Shortcuts</Text>
            <Text color={T.border}>───────────</Text>
            <Text>
              <Text color={T.user}>esc</Text>      中断
            </Text>
            <Text>
              <Text color={T.user}>ctrl+c×2</Text> 退出
            </Text>
            <Text>
              <Text color={T.user}>↑↓</Text>       历史翻阅
            </Text>
          </Box>
        )}
      </Box>
      <Text> </Text>
      <Text color={T.muted}>  esc 中断 · ctrl+c×2 退出 · /help 查看命令</Text>
    </Box>
  );
}
