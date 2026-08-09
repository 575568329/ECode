// ============================================================
// SkillDialog —— /skill 审批（M6 阶段D §16.2 picker + §16.3 详情 + 4 操作）
// ============================================================
//
// 两阶段（各自带 useInput，避免条件 hooks）：
//   SkillDialog（外壳，管 detailIdx）→ SkillList（picker，↑↓/Enter/Esc）
//                                 → SkillDetail（description + evidence + body + 扫描 + a/p/e/r）
//
// 不复用 permission-dialog：后者 allow/deny 3 态权限闸；skill 审批是 accept/promote/edit/reject
// 4 操作 + 需展示 evidence/正文/扫描结果，语义/信息量不同（§16.3）。
//
// edit：不做（提案/已安装 skill 均普通 .md，用户自行编辑后 /skill 重载，§18 消解）。
// critical → [a]/[p] 禁用（§6.3 强制 quarantine）。

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { T } from './theme.js';
import { PickerList, type PickerItem } from './picker-list.js';
import type { ProposalRecord } from '../skill-capture/proposal.js';

export type SkillAction = 'accept' | 'promote' | 'reject';

interface SkillDialogProps {
  /** 当前 pending 提案（app 层持有，操作后刷新传入 → 本组件重渲染）。 */
  proposals: ProposalRecord[];
  /** 执行审批操作（app 层调 proposal.ts + 反馈 + 刷新列表）。 */
  onAction: (action: SkillAction, record: ProposalRecord) => void;
  onClose: () => void;
}

const LIST_MAX_ITEMS = 6;
/** 详情正文预览上限（避免撑爆终端；全文在文件里）。 */
const BODY_PREVIEW = 240;
/** evidence 预览条数 + 单条字符上限。 */
const EVIDENCE_PREVIEW = 3;
const EVIDENCE_CHARS = 64;

/** 外壳：管 detailIdx，分发到列表/详情（自身只调 useState，无条件 hooks 问题）。 */
export function SkillDialog({ proposals, onAction, onClose }: SkillDialogProps): React.ReactElement {
  const [detailIdx, setDetailIdx] = useState<number | null>(null);

  if (detailIdx !== null && proposals[detailIdx]) {
    const rec = proposals[detailIdx];
    return (
      <SkillDetail
        record={rec}
        onAction={(a) => {
          setDetailIdx(null); // 操作后回列表（accept/reject 删记录；promote 也回列表便于连续审批）
          onAction(a, rec);
        }}
        onBack={() => setDetailIdx(null)}
      />
    );
  }
  return <SkillList proposals={proposals} onPick={setDetailIdx} onClose={onClose} />;
}

/** 列表阶段：picker（复用 PickerList，meta 放 version + critical 标记）。 */
function SkillList({
  proposals,
  onPick,
  onClose,
}: {
  proposals: ProposalRecord[];
  onPick: (idx: number) => void;
  onClose: () => void;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const len = proposals.length;
  const safeIndex = len === 0 ? 0 : Math.min(index, len - 1);

  useInput((_input, key) => {
    if (len === 0) return;
    if (key.upArrow) {
      setIndex((i) => (i - 1 + len) % len);
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % len);
      return;
    }
    if (key.return) {
      onPick(safeIndex);
      return;
    }
    if (key.escape) onClose();
  });

  // 空列表兜底（app 层 pending=0 不开 dialog，但 reload 后可能变空）
  if (len === 0) {
    return (
      <Box flexDirection="column">
        <Text color={T.muted}>暂无待审批提案。用 /skill-gen 从观察记录归纳。</Text>
      </Box>
    );
  }

  const items: PickerItem[] = proposals.map((p) => ({
    name: p.name,
    description: p.frontmatter.description,
    meta: `v${p.frontmatter.version}${p.scan.hasCritical ? ' ⚠' : ''}`,
  }));

  return (
    <Box flexDirection="column">
      <Text color={T.muted}>审批技能提案（{len}）</Text>
      <PickerList
        items={items}
        selectedIndex={safeIndex}
        maxItems={LIST_MAX_ITEMS}
        prefix=""
        hint="↑↓ 选择 · enter 详情 · esc 返回"
      />
    </Box>
  );
}

/** 详情阶段：description + evidence + 正文预览 + 扫描结果 + 4 操作键。 */
function SkillDetail({
  record,
  onAction,
  onBack,
}: {
  record: ProposalRecord;
  onAction: (action: SkillAction) => void;
  onBack: () => void;
}): React.ReactElement {
  const critical = record.scan.hasCritical;
  const warnCount = record.scan.findings.filter((f) => f.severity === 'warn').length;
  const fm = record.frontmatter;

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (input === 'a') {
      if (!critical) onAction('accept');
      return;
    }
    if (input === 'p') {
      if (!critical) onAction('promote');
      return;
    }
    if (input === 'r') {
      onAction('reject');
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={critical ? T.error : T.accent} paddingX={2} paddingY={1}>
      <Text color={T.accent} bold>
        Skill 提案：{record.name}
      </Text>
      <Text color={T.muted}>description: {fm.description}</Text>
      <Text> </Text>
      <Text color={T.muted}>evidence（归纳依据）：</Text>
      {fm.evidence.slice(0, EVIDENCE_PREVIEW).map((e, i) => (
        <Text key={i} color={T.muted} wrap="truncate">
          {'  '}• [{e.ts.slice(5, 10)}] {e.content.slice(0, EVIDENCE_CHARS)}
        </Text>
      ))}
      {fm.evidence.length > EVIDENCE_PREVIEW ? (
        <Text color={T.muted}>  …（共 {fm.evidence.length} 条）</Text>
      ) : null}
      <Text> </Text>
      <Text>{record.body.slice(0, BODY_PREVIEW)}{record.body.length > BODY_PREVIEW ? ' …' : ''}</Text>
      <Text> </Text>
      {critical ? (
        <Text color={T.error} bold>
          ⛔ 检测到 critical 风险（{record.scan.findings.filter((f) => f.severity === 'critical').length} 条），accept/promote 已禁用
        </Text>
      ) : (
        <Text color={warnCount > 0 ? T.warning : T.muted}>
          🔒 安全扫描：{warnCount > 0 ? `${warnCount} warn` : 'clean（0 critical · 0 warn）'}
        </Text>
      )}
      <Text> </Text>
      <Text color={T.muted}>[a] accept 项目级 · [p] promote 用户级 · [r] reject · [Esc] 返回</Text>
    </Box>
  );
}
