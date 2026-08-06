import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ChatView } from '../../src/ui/chat-view.js';
import type { UseAgentStreamReturn } from '../../src/ui/use-agent-stream.js';
import { SYMBOLS } from '../../src/ui/theme.js';

function makeState(over: Partial<UseAgentStreamReturn> = {}): UseAgentStreamReturn {
  return {
    completedMessages: [],
    streamingText: null,
    activeTools: [],
    pendingReadSearch: [],
    pendingPermission: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    isRunning: false,
    error: null,
    submit: () => {},
    resolvePermission: () => {},
    abort: () => {},
    isAllowAlways: () => false,
    clear: () => {},
    ...over,
  } as UseAgentStreamReturn;
}

describe('<ChatView />', () => {
  it('渲染已完成用户消息（❯ 你 前缀）', () => {
    const state = makeState({
      completedMessages: [{ kind: 'user', id: 'u1', text: '帮我' }],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.user);
    expect(f).toContain('帮我');
  });

  it('用户消息渲染左边框 │（角色区分，M3.5 Phase 1）', () => {
    const state = makeState({
      completedMessages: [{ kind: 'user', id: 'u1', text: '帮我' }],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    expect(lastFrame()).toContain('│');
  });

  it('warning/error 消息渲染左边框 │（系统消息同构区分）', () => {
    const state = makeState({
      completedMessages: [
        { kind: 'warning', id: 'w1', text: '上下文已压缩' },
        { kind: 'error', id: 'e1', text: '出错了' },
      ],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('│');
    expect(f).toContain('上下文已压缩');
    expect(f).toContain('出错了');
  });

  it('渲染已完成助手消息（◆ ECode 前缀 + markdown）', () => {
    const state = makeState({
      completedMessages: [{ kind: 'assistant', id: 'a1', text: '好的' }],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.brand);
    expect(f).toContain('好的');
  });

  it('动态区显示 streamingText（流式纯文本）', () => {
    const state = makeState({ streamingText: '正在打字', isRunning: true });
    const { lastFrame } = render(<ChatView state={state} />);
    expect(lastFrame()).toContain('正在打字');
  });

  it('动态区显示运行中工具（▸ + spinner）', () => {
    const state = makeState({
      isRunning: true,
      activeTools: [{ id: 't1', name: 'bash', startedAt: Date.now() }],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    expect(lastFrame()).toContain('bash');
  });

  it('已完成工具消息走 ToolDone（单行 → Inline 模式）', () => {
    const state = makeState({
      completedMessages: [
        { kind: 'tool', id: 't1', name: 'bash', content: 'done', isError: false },
      ],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    // 单行 bash → Inline 模式，渲染 ✓ 图标 + 工具名 + 摘要
    expect(f).toContain(SYMBOLS.success);
    expect(f).toContain('bash');
    expect(f).toContain('done');
  });

  it('已完成工具含 input → 历史区显示参数摘要', () => {
    const state = makeState({
      completedMessages: [
        { kind: 'tool', id: 't2', name: 'bash', content: 'line1\nline2\nline3\nline4', isError: false, input: { command: 'npm test' } },
      ],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    // BlockTool 显示参数
    expect(f).toContain('npm test');
    // BlockTool 渲染左边框
    expect(f).toContain('│');
  });

  it('动态区运行中工具显示参数摘要（Phase 2 input 透传）', () => {
    const state = makeState({
      isRunning: true,
      activeTools: [{ id: 't3', name: 'bash', startedAt: Date.now(), input: { command: 'npm run build' } }],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    expect(lastFrame()).toContain('npm run build');
  });

  it('折叠组 tool_group → 单行摘要（✓ + search + Read N files + ctrl+o）', () => {
    const state = makeState({
      completedMessages: [
        {
          kind: 'tool_group', id: 'g1',
          tools: [
            { name: 'read_file', content: 'a', isError: false },
            { name: 'read_file', content: 'b', isError: false },
            { name: 'read_file', content: 'c', isError: false },
          ],
        },
      ],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.success);
    expect(f).toContain('Read 3 files');
    expect(f).toContain('ctrl+o');
  });

  it('折叠组含错误 → 渲染 ✗ 图标', () => {
    const state = makeState({
      completedMessages: [
        {
          kind: 'tool_group', id: 'g2',
          tools: [
            { name: 'read_file', content: 'a', isError: false },
            { name: 'grep', content: 'err', isError: true },
          ],
        },
      ],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    expect(lastFrame()).toContain(SYMBOLS.error);
  });

  it('动态区挂起只读组 → 实时合并摘要（· · · + Read N files）', () => {
    const state = makeState({
      isRunning: true,
      pendingReadSearch: [
        { kind: 'tool', id: 'p1', name: 'read_file', content: 'a', isError: false },
        { kind: 'tool', id: 'p2', name: 'read_file', content: 'b', isError: false },
      ],
    });
    const { lastFrame } = render(<ChatView state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Read 2 files');
    expect(f).toContain('· · ·');
  });
});
