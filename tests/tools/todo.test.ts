// extractTodos / executeTodoWrite 单测（M3.5 Step 3，消息队列与交互重做方案 §6）。
// 纯函数，覆盖正常解析 + 容错（畸形输入/空/缺字段/未知 status）。
import { describe, it, expect } from 'vitest';
import { extractTodos, executeTodoWrite } from '../../src/tools/todo.js';

describe('extractTodos', () => {
  it('正常解析 todos 数组（含 activeForm 与缺省）', () => {
    const result = extractTodos({
      todos: [
        { content: '读取文件', status: 'in_progress', activeForm: '正在读取' },
        { content: '写测试', status: 'pending' },
        { content: '已完成项', status: 'completed' },
      ],
    });
    expect(result).toEqual([
      { content: '读取文件', status: 'in_progress', activeForm: '正在读取' },
      { content: '写测试', status: 'pending', activeForm: undefined },
      { content: '已完成项', status: 'completed', activeForm: undefined },
    ]);
  });

  it('input 缺失返回 null（调用方保持旧 todos）', () => {
    expect(extractTodos(undefined)).toBeNull();
  });

  it('todos 非数组返回 null', () => {
    expect(extractTodos({ todos: 'not array' })).toBeNull();
    expect(extractTodos({})).toBeNull();
  });

  it('未知 status 降级为 pending', () => {
    const result = extractTodos({ todos: [{ content: 'x', status: 'bogus' }] });
    expect(result?.[0].status).toBe('pending');
  });

  it('空 content 项被丢弃', () => {
    const result = extractTodos({
      todos: [
        { content: '', status: 'pending' },
        { content: '有效', status: 'pending' },
      ],
    });
    expect(result?.length).toBe(1);
    expect(result?.[0].content).toBe('有效');
  });

  it('非对象项被过滤', () => {
    const result = extractTodos({
      todos: ['str', null, 42, { content: 'ok', status: 'pending' }],
    });
    expect(result?.length).toBe(1);
    expect(result?.[0].content).toBe('ok');
  });
});

describe('executeTodoWrite', () => {
  it('空列表回执「清空」', () => {
    const r = executeTodoWrite({ todos: [] });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('清空');
  });

  it('正常列表回执带状态符号', () => {
    const r = executeTodoWrite({
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('✓');
    expect(r.content).toContain('▶');
    expect(r.content).toContain('◻');
  });

  it('畸形输入容错（不崩，按可解析项回执）', () => {
    const r = executeTodoWrite({ todos: [{ content: 'ok', status: 'pending' }, null] });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('1 项');
  });
});
