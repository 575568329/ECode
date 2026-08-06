import { describe, it, expect } from 'vitest';
import { displayWidth, padEndDisplay } from '../../src/ui/display-width.js';

// 背景：markdown 表格列对齐按 string.length 算列宽 + padEnd 补空格，
// 但中文 length=2 占 2 个终端列 → padEnd 误判已满不补 → 后续 │ 右移错位。
// displayWidth 按 Unicode East Asian Width 算真实显示宽度，修复此问题。

describe('displayWidth（终端显示宽度）', () => {
  it('纯 ASCII → 长度即宽度（空串为 0）', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('')).toBe(0);
  });

  it('纯中文 → 每字占 2 列（length=2 但显示宽=4）', () => {
    expect(displayWidth('配色')).toBe(4);
    expect(displayWidth('中文测试')).toBe(8);
  });

  it('混合中英文 → 按显示宽度累加（非 length）', () => {
    // 配色(4) + ：(全角,2) + 17(2) + 个(2) = 10；按 length 算会是 6
    expect(displayWidth('配色：17个')).toBe(10);
  });

  it('全角标点（：（）占 2 列', () => {
    expect(displayWidth('：')).toBe(2);
    expect(displayWidth('（')).toBe(2);
  });

  it('半角符号占 1 列', () => {
    expect(displayWidth(':')).toBe(1);
    expect(displayWidth('|')).toBe(1);
  });
});

describe('padEndDisplay（按显示宽度右侧补空格）', () => {
  it('中文补到目标显示宽度（padEnd 按 length 会补错）', () => {
    // '配色' 显示宽 4，目标 6 → 补 2 空格（length 变 4 但显示宽 6）
    expect(padEndDisplay('配色', 6)).toBe('配色' + '  ');
    expect(displayWidth(padEndDisplay('配色', 6))).toBe(6);
  });

  it('已达/超目标显示宽度 → 不补', () => {
    expect(padEndDisplay('abcd', 4)).toBe('abcd');
    expect(padEndDisplay('abcde', 3)).toBe('abcde');
  });
});
