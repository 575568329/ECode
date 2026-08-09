// ActivityIndicator 单测：deriveActivity 纯函数优先级链 + 组件文案渲染。
// 详见 plan:统一指示器收口散落的 loading。
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { deriveActivity, ActivityIndicator, type ActivityState } from '../../src/ui/activity-indicator.js';
import { SYMBOLS } from '../../src/ui/theme.js';

/** 构造最小 ActivityState（deriveActivity 依赖的字段，其余默认）。 */
function makeState(over: Partial<ActivityState>): ActivityState {
  return {
    isCompacting: false,
    isRunning: false,
    streamingText: null,
    activeTools: [],
    pendingReadSearch: [],
    ...over,
  };
}

describe('deriveActivity（优先级链）', () => {
  it('isCompacting=true → compacting（最高优先级，压过 thinking）', () => {
    expect(deriveActivity(makeState({ isCompacting: true, isRunning: true }))).toEqual({ kind: 'compacting' });
  });

  it('activeTools 非空 → tools（带 count）', () => {
    const s = makeState({
      isRunning: true,
      activeTools: [
        { id: 't1', name: 'bash', startedAt: 0 },
        { id: 't2', name: 'read_file', startedAt: 0 },
        { id: 't3', name: 'grep', startedAt: 0 },
      ],
    });
    expect(deriveActivity(s)).toEqual({ kind: 'tools', count: 3 });
  });

  it('streamingText 非空 → replying', () => {
    expect(deriveActivity(makeState({ isRunning: true, streamingText: '正在打字' }))).toEqual({
      kind: 'replying',
    });
  });

  it('pendingReadSearch 非空 → reading（summary 复用 summarizeGroup）', () => {
    const s = makeState({
      isRunning: true,
      pendingReadSearch: [
        { kind: 'tool', id: 'p1', name: 'read_file', content: 'a', isError: false },
        { kind: 'tool', id: 'p2', name: 'read_file', content: 'b', isError: false },
      ],
    });
    const r = deriveActivity(s);
    expect(r?.kind).toBe('reading');
    if (r?.kind === 'reading') expect(r.summary).toContain('Read 2 files');
  });

  it('isRunning 且无其他态 → thinking', () => {
    expect(deriveActivity(makeState({ isRunning: true }))).toEqual({ kind: 'thinking' });
  });

  it('idle（isRunning=false）→ null', () => {
    expect(deriveActivity(makeState({}))).toBeNull();
  });

  it('优先级冲突：activeTools + pendingReadSearch 同时非空 → 落 tools', () => {
    const s = makeState({
      isRunning: true,
      activeTools: [{ id: 't1', name: 'bash', startedAt: 0 }],
      pendingReadSearch: [{ kind: 'tool', id: 'p1', name: 'read_file', content: 'a', isError: false }],
    });
    expect(deriveActivity(s)).toEqual({ kind: 'tools', count: 1 });
  });

  it('优先级冲突：compacting 压过 activeTools', () => {
    const s = makeState({
      isCompacting: true,
      isRunning: true,
      activeTools: [{ id: 't1', name: 'bash', startedAt: 0 }],
    });
    expect(deriveActivity(s)).toEqual({ kind: 'compacting' });
  });
});

describe('<ActivityIndicator />（文案渲染）', () => {
  it('thinking 态渲染 ◆ + 思考中', () => {
    const { lastFrame } = render(<ActivityIndicator phase={{ kind: 'thinking' }} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.brand);
    expect(f).toContain('思考中');
  });

  it('replying 态渲染 回复中', () => {
    const { lastFrame } = render(<ActivityIndicator phase={{ kind: 'replying' }} />);
    expect(lastFrame()).toContain('回复中');
  });

  it('compacting 态渲染 压缩中', () => {
    const { lastFrame } = render(<ActivityIndicator phase={{ kind: 'compacting' }} />);
    expect(lastFrame()).toContain('压缩中');
  });

  it('tools 态渲染「运行 N 个工具」', () => {
    const { lastFrame } = render(<ActivityIndicator phase={{ kind: 'tools', count: 3 }} />);
    expect(lastFrame()).toContain('运行 3 个工具');
  });

  it('reading 态渲染 · · · 前缀 + summary', () => {
    const { lastFrame } = render(<ActivityIndicator phase={{ kind: 'reading', summary: 'Read 2 files' }} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('· · ·');
    expect(f).toContain('Read 2 files');
  });
});
