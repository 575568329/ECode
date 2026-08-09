// StatusBar —— 单行贴底状态栏（spec §8.4⑧ / §8.1 Ctx 三色阈值）。
// ⏱ 耗时 | ↑↓ tok | $费用 | Ctx% | model @ provider | [动态段]
import React from 'react';
import { Text, Box } from 'ink';
import { T } from './theme.js';
import { computeCost } from '../providers/cost.js';
import type { PermissionMode } from '../permission/types.js';
import type { ECodeUsage, ModelCost } from '../providers/types.js';

export type StatusBarPhase = 'idle' | 'streaming' | 'exit-window' | 'permission';

interface StatusBarProps {
  usage: ECodeUsage;
  model: string;
  provider: string;
  /** 上下文占用百分比（0-100）。≤80 muted / >80 warning / >95 error。 */
  ctxPercent: number;
  phase: StatusBarPhase;
  /** 会话起始时间（ms），算耗时。 */
  startedAt: number;
  /** 待处理消息条数（>0 显示"待处理:N"，排队反馈）。 */
  pendingCount?: number;
  /** 当前权限档（非 default 时显示徽标，Shift+Tab 切换的可见反馈）。 */
  permissionMode?: PermissionMode;
  /** 当前模型单价（$/M token），缺省显示 $--（不计费，如订阅制 GLM）。 */
  cost?: ModelCost;
}

/** token 数 → 1.2K / 12.5K / 1.2M 简写。 */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 费用显示：无单价（订阅制/未配 cost）显示 $--;否则按 computeCost 精确计算（支点17）。 */
function fmtCost(usage: ECodeUsage, cost: ModelCost | undefined): string {
  if (!cost) return '$--';
  return `$${computeCost(usage, cost).toFixed(2)}`;
}

function ctxColor(pct: number): string {
  if (pct > 95) return T.error;
  if (pct > 80) return T.warning;
  return T.muted;
}

function dynamicText(phase: StatusBarPhase): { text: string; color: string } {
  switch (phase) {
    case 'streaming':
      return { text: 'ctrl+c to interrupt', color: T.warning };
    case 'exit-window':
      return { text: 'press ctrl+c again to exit', color: T.warning };
    case 'permission':
      return { text: '', color: T.muted }; // 弹窗自带提示
    case 'idle':
    default:
      return { text: '/help for commands', color: T.muted };
  }
}

/** 权限档徽标文本/颜色：default 不显示（省空间）；acceptEdits 提示；bypass 警告（红）。 */
function modeBadge(mode: PermissionMode | undefined): { text: string; color: string } | null {
  switch (mode) {
    case 'acceptEdits':
      return { text: 'accept-edits', color: T.warning };
    case 'bypass':
      return { text: '⚠ bypass', color: T.error };
    case 'default':
    default:
      return null; // default 不占位，StatusBar 保持简洁
  }
}

export function StatusBar({ usage, model, provider, ctxPercent, phase, startedAt, pendingCount, permissionMode, cost }: StatusBarProps): React.ReactElement {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');
  const dyn = dynamicText(phase);
  const badge = modeBadge(permissionMode);
  return (
    <Box>
      <Text color={T.muted}>⏱ {mm}:{ss}</Text>
      <Text>  </Text>
      <Text color={T.info}>↑{fmtTok(usage.inputTokens)}</Text>
      <Text color={T.muted}> ↓{fmtTok(usage.outputTokens)} tok</Text>
      <Text>  </Text>
      <Text color={T.success}>{fmtCost(usage, cost)}</Text>
      <Text>  </Text>
      <Text color={ctxColor(ctxPercent)}>Ctx {ctxPercent}%</Text>
      <Text>  </Text>
      <Text color={T.muted}>{model} @ {provider}</Text>
      {pendingCount != null && pendingCount > 0 ? (
        <>
          <Text>  </Text>
          <Text color={T.brand}>待处理 {pendingCount}</Text>
        </>
      ) : null}
      {badge ? (
        <>
          <Text>  </Text>
          <Text color={badge.color}>{badge.text}</Text>
        </>
      ) : null}
      <Box flexGrow={1} />
      {dyn.text ? <Text color={dyn.color}>{dyn.text}</Text> : null}
    </Box>
  );
}
