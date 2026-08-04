import { describe, it, expect } from 'vitest';
import { shouldAsk, AllowList } from '../src/permission.js';

describe('shouldAsk', () => {
  it('dangerous 且未在 allow 列表 → true（需询问）', () => {
    const allow = new AllowList();
    expect(shouldAsk('bash', true, allow)).toBe(true);
  });

  it('dangerous 但已在 allow 列表 → false（已批准，放行）', () => {
    const allow = new AllowList();
    allow.add('bash');
    expect(shouldAsk('bash', true, allow)).toBe(false);
  });

  it('非 dangerous（undefined）→ false（只读放行）', () => {
    const allow = new AllowList();
    expect(shouldAsk('read_file', false, allow)).toBe(false);
  });
});

describe('AllowList', () => {
  it('add 后 has 返回 true', () => {
    const allow = new AllowList();
    expect(allow.has('bash')).toBe(false);
    allow.add('bash');
    expect(allow.has('bash')).toBe(true);
  });

  it('不同工具名互不影响', () => {
    const allow = new AllowList();
    allow.add('bash');
    expect(allow.has('edit_file')).toBe(false);
  });
});
