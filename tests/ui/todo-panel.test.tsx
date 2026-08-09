// TodoPanel 单测：排序 / completed 折叠 / maxHeight 截断（消息队列与交互重做方案 §7.4）。
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { TodoPanel } from '../../src/ui/todo-panel.js';
import { SYMBOLS } from '../../src/ui/theme.js';
import type { TodoItem } from '../../src/tools/todo.js';

describe('<TodoPanel />', () => {
  it('空列表不渲染（不占位）', () => {
    const { lastFrame } = render(<TodoPanel todos={[]} />);
    expect(lastFrame()).toBe('');
  });

  it('in_progress 排在 pending 前（当前焦点优先）', () => {
    const todos: TodoItem[] = [
      { content: '待办A', status: 'pending' },
      { content: '进行中B', status: 'in_progress' },
      { content: '待办C', status: 'pending' },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const f = lastFrame() ?? '';
    expect(f.indexOf('进行中B')).toBeLessThan(f.indexOf('待办A'));
    expect(f).toContain(SYMBOLS.todoProgress); // ◾ in_progress
    expect(f).toContain(SYMBOLS.todoPending); // ◻ pending
  });

  it('completed 折叠为单行「✓ N 已完成」（不逐条占行）', () => {
    const todos: TodoItem[] = [
      { content: '任务1', status: 'completed' },
      { content: '任务2', status: 'completed' },
      { content: '进行中', status: 'in_progress' },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('待办 (2/3)'); // header：done/total
    expect(f).toContain('2 已完成');
    expect(f).not.toContain('任务1'); // completed 不逐条显示
    expect(f).toContain('进行中'); // active 仍显示
  });

  it('active 超过 MAX_ACTIVE(6) → 截断 + 提示还有 M 条（§7.4 防顶屏）', () => {
    const todos: TodoItem[] = Array.from({ length: 8 }, (_, i) => ({
      content: `待办${i}`,
      status: 'pending' as const,
    }));
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('… +2 条待办');
    expect(f).toContain('待办0'); // 前 6 条保留
    expect(f).toContain('待办5');
    expect(f).not.toContain('待办6'); // 第 7 条截断
  });

  it('标题行缩进2格与子项内容列对齐（符号◾/◻占首2列，标题文字落到内容列共线）', () => {
    const todos: TodoItem[] = [{ content: '任务A', status: 'pending' }];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    // strip ANSI 颜色码后断言前导空格（lastFrame 带 muted 色，须去色才能精确比前缀）。
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const firstLine = stripAnsi((lastFrame() ?? '').split('\n')[0] ?? '');
    // 子项「符号+空格」占首2列、正文落在列2；标题同样落到列2，使「待办…」与任务正文、
    // 底部「… 条」「✓ N 已完成」的文字列共线（根治标题顶格与正文错位的视觉问题）。
    expect(firstLine).toBe('  待办 (0/1)');
  });
});
