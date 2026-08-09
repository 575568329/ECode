// frontmatter 序列化/解析 round-trip 测试（M6 阶段D §4 归纳层）。
// 零依赖手 split：evidence.content JSON 转义、多证据条目、缺字段降级。
import { describe, it, expect } from 'vitest';
import { serializeProposal, parseProposal } from '../src/skill-capture/frontmatter.js';
import type { ProposalFrontmatter } from '../src/skill-capture/frontmatter.js';

const fm: ProposalFrontmatter = {
  name: 'precommit-test',
  description: '提交前必跑 npm test',
  status: 'proposal',
  version: 1,
  date: '2026-08-09',
  hash: 'abc123',
  evidence: [{ ts: '2026-08-09T21:35:07Z', session: 's1', content: '下次提交前先跑 npm test' }],
};

describe('serializeProposal / parseProposal round-trip', () => {
  it('序列化含 frontmatter + body，解析还原全部字段', () => {
    const md = serializeProposal(fm, '# 提交前测试\n提交前跑 npm test');
    const parsed = parseProposal(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.name).toBe('precommit-test');
    expect(parsed!.frontmatter.description).toBe('提交前必跑 npm test');
    expect(parsed!.frontmatter.status).toBe('proposal');
    expect(parsed!.frontmatter.version).toBe(1);
    expect(parsed!.frontmatter.date).toBe('2026-08-09');
    expect(parsed!.frontmatter.hash).toBe('abc123');
    expect(parsed!.frontmatter.evidence).toHaveLength(1);
    expect(parsed!.frontmatter.evidence[0].content).toBe('下次提交前先跑 npm test');
    expect(parsed!.body).toContain('# 提交前测试');
  });

  it('content 含双引号 → JSON 转义 round-trip（不破坏 frontmatter 结构）', () => {
    const fm2: ProposalFrontmatter = {
      ...fm,
      evidence: [{ ts: 't', session: 's', content: '含"引号"和\\反斜杠的内容' }],
    };
    const md = serializeProposal(fm2, 'body');
    const parsed = parseProposal(md);
    expect(parsed!.frontmatter.evidence[0].content).toBe('含"引号"和\\反斜杠的内容');
  });

  it('多条 evidence 按序保留', () => {
    const fm2: ProposalFrontmatter = {
      ...fm,
      evidence: [
        { ts: 't1', session: 's1', content: 'c1' },
        { ts: 't2', session: 's2', content: 'c2' },
        { ts: 't3', session: 's3', content: 'c3' },
      ],
    };
    const parsed = parseProposal(serializeProposal(fm2, 'body'));
    expect(parsed!.frontmatter.evidence).toHaveLength(3);
    expect(parsed!.frontmatter.evidence[1].content).toBe('c2');
    expect(parsed!.frontmatter.evidence[2].ts).toBe('t3');
  });

  it('无 frontmatter（纯正文）→ null', () => {
    expect(parseProposal('纯正文无 frontmatter')).toBeNull();
  });

  it('缺 name → null（必填校验）', () => {
    const md = serializeProposal(fm, 'body').replace(/name: precommit-test\n/, '');
    expect(parseProposal(md)).toBeNull();
  });

  it('缺 description → null（必填校验）', () => {
    const md = serializeProposal(fm, 'body').replace(/description: 提交前必跑 npm test\n/, '');
    expect(parseProposal(md)).toBeNull();
  });

  it('evidence 为空数组 → 序列化仅留 evidence: 头，解析还原空数组', () => {
    const fm2: ProposalFrontmatter = { ...fm, evidence: [] };
    const parsed = parseProposal(serializeProposal(fm2, 'body'));
    expect(parsed!.frontmatter.evidence).toEqual([]);
  });
});
