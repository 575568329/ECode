import { describe, it, expect } from 'vitest';
import { T, SYMBOLS, SPINNER_FRAMES } from '../../src/ui/theme.js';

describe('视觉基础', () => {
  it('T 含 17 个语义 token，值为 hex', () => {
    const keys = Object.keys(T);
    expect(keys).toHaveLength(17);
    // 抽查 spec §8.1 的关键 token 值
    expect(T.brand).toBe('#4ECDC4');
    expect(T.user).toBe('#89B4FA'); // 蓝，非绿（避免撞 success）
    expect(T.success).toBe('#A6E3A1');
    expect(T.permission).toBe('#FAB387'); // 独立 token，不复用 error
    // 全部 hex 格式
    for (const v of Object.values(T)) {
      expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('SYMBOLS 全单宽 Unicode 几何，无 emoji', () => {
    expect(SYMBOLS.user).toBe('❯');
    expect(SYMBOLS.brand).toBe('◆');
    expect(SYMBOLS.tool).toBe('▸');
    expect(SYMBOLS.result).toBe('↳'); // 非 ⎿（CC 签名）
    expect(SYMBOLS.success).toBe('✓');
    expect(SYMBOLS.error).toBe('✗');
    expect(SYMBOLS.warning).toBe('▲');
    expect(SYMBOLS.thinking).toBe('◐');
    expect(SYMBOLS.prompt).toBe('▶');
    // 全部恰好 1 个码点（emoji 多码点会破坏对齐）
    for (const v of Object.values(SYMBOLS)) {
      expect([...v].length).toBe(1);
    }
  });

  it('SPINNER_FRAMES 是 braille 序列', () => {
    expect(SPINNER_FRAMES).toBe('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏');
    expect([...SPINNER_FRAMES].length).toBe(10);
  });
});
