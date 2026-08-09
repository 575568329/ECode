// SkillDialog 测试（M6 阶段D §16）：列表 picker → 详情 → accept/promote/reject 按键 + critical 禁用。
// 用 simulate() 驱动（fake timer + ink setState 节流冲刷 + 正确 CSI/Esc 编码，见 simulate.ts）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { simulate } from './simulate.js';
import { SkillDialog } from '../../src/ui/skill-dialog.js';
import type { ProposalRecord } from '../../src/skill-capture/proposal.js';

/** 构造 ProposalRecord fixture（避开文件 IO）。 */
function rec(name: string, opts?: { critical?: boolean; version?: number }): ProposalRecord {
  return {
    name,
    filePath: `/tmp/${name}.md`,
    frontmatter: {
      name,
      description: `${name} 的描述`,
      status: 'proposal',
      version: opts?.version ?? 1,
      date: '2026-08-09',
      hash: `h-${name}`,
      evidence: [{ ts: '2026-08-09T21:35:07Z', session: 's1', content: `${name} 归纳依据` }],
    },
    body: `# ${name}\n这是正文内容`,
    scan: opts?.critical
      ? { findings: [{ rule: 'prompt-injection-ignore', severity: 'critical', match: 'ignore all previous instructions' }], hasCritical: true }
      : { findings: [], hasCritical: false },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SkillDialog · 列表阶段', () => {
  it('渲染 pending 提案名 + version + 操作提示', async () => {
    const sim = simulate(
      <SkillDialog proposals={[rec('precommit'), rec('format-style')]} onAction={() => {}} onClose={() => {}} />,
    );
    await sim.waitFor((f) => f.includes('precommit'));
    const f = sim.plain();
    expect(f).toContain('precommit');
    expect(f).toContain('format-style');
    expect(f).toContain('v1');
    expect(f).toContain('enter 详情');
    sim.unmount();
  });

  it('critical 提案 → 列表项标 ⚠', async () => {
    const sim = simulate(
      <SkillDialog proposals={[rec('bad', { critical: true })]} onAction={() => {}} onClose={() => {}} />,
    );
    await sim.waitFor((f) => f.includes('bad'));
    expect(sim.plain()).toContain('⚠');
    sim.unmount();
  });

  it('Esc → onClose', async () => {
    const onClose = vi.fn();
    const sim = simulate(<SkillDialog proposals={[rec('precommit')]} onAction={() => {}} onClose={onClose} />);
    await sim.waitFor((f) => f.includes('precommit'));
    await sim.esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    sim.unmount();
  });
});

describe('SkillDialog · 详情阶段', () => {
  it('Enter → 详情显 description/evidence/正文/keymap', async () => {
    const sim = simulate(
      <SkillDialog proposals={[rec('precommit')]} onAction={() => {}} onClose={() => {}} />,
    );
    await sim.waitFor((f) => f.includes('precommit'));
    await sim.enter();
    await sim.waitFor((f) => f.includes('evidence'));
    const f = sim.plain();
    expect(f).toContain('description: precommit 的描述');
    expect(f).toContain('这是正文内容');
    expect(f).toContain('[a] accept');
    expect(f).toContain('[p] promote');
    sim.unmount();
  });

  it('详情 [a] → onAction(accept)', async () => {
    const onAction = vi.fn();
    const sim = simulate(<SkillDialog proposals={[rec('precommit')]} onAction={onAction} onClose={() => {}} />);
    await sim.waitFor((f) => f.includes('precommit'));
    await sim.enter();
    await sim.waitFor((f) => f.includes('[a] accept'));
    await sim.type('a');
    expect(onAction).toHaveBeenCalledWith('accept', expect.objectContaining({ name: 'precommit' }));
    sim.unmount();
  });

  it('详情 [r] → onAction(reject)', async () => {
    const onAction = vi.fn();
    const sim = simulate(<SkillDialog proposals={[rec('precommit')]} onAction={onAction} onClose={() => {}} />);
    await sim.waitFor((f) => f.includes('precommit'));
    await sim.enter();
    await sim.waitFor((f) => f.includes('[r] reject'));
    await sim.type('r');
    expect(onAction).toHaveBeenCalledWith('reject', expect.anything());
    sim.unmount();
  });

  it('详情 [p] → onAction(promote)', async () => {
    const onAction = vi.fn();
    const sim = simulate(<SkillDialog proposals={[rec('precommit')]} onAction={onAction} onClose={() => {}} />);
    await sim.waitFor((f) => f.includes('precommit'));
    await sim.enter();
    await sim.waitFor((f) => f.includes('[p] promote'));
    await sim.type('p');
    expect(onAction).toHaveBeenCalledWith('promote', expect.anything());
    sim.unmount();
  });

  it('critical 详情 → ⛔ 提示 + [a] 不触发（accept 禁用）', async () => {
    const onAction = vi.fn();
    const sim = simulate(<SkillDialog proposals={[rec('bad', { critical: true })]} onAction={onAction} onClose={() => {}} />);
    await sim.waitFor((f) => f.includes('bad'));
    await sim.enter();
    await sim.waitFor((f) => f.includes('⛔'));
    await sim.type('a'); // critical → accept 被拦
    expect(onAction).not.toHaveBeenCalled();
    sim.unmount();
  });

  it('详情 Esc → 回列表', async () => {
    const sim = simulate(
      <SkillDialog proposals={[rec('precommit'), rec('format')]} onAction={() => {}} onClose={() => {}} />,
    );
    await sim.waitFor((f) => f.includes('precommit'));
    await sim.enter();
    await sim.waitFor((f) => f.includes('evidence'));
    await sim.esc(); // Esc 回列表
    await sim.waitFor((f) => f.includes('enter 详情'));
    expect(sim.plain()).not.toContain('evidence'); // 回到列表
    sim.unmount();
  });

  it('↓ 在列表导航 → Enter 进选中项详情', async () => {
    const sim = simulate(
      <SkillDialog proposals={[rec('a'), rec('b'), rec('c')]} onAction={() => {}} onClose={() => {}} />,
    );
    await sim.waitFor((f) => f.includes('审批技能提案'));
    await sim.down();
    await sim.enter();
    await sim.waitFor((f) => f.includes('description: b 的描述'));
    expect(sim.plain()).toContain('description: b 的描述');
    sim.unmount();
  });
});
