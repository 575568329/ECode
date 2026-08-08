import { describe, it, expect } from 'vitest';
import { reduceAgentEvent, initialStreamState, flushReadSearch } from '../../src/ui/reduce-agent-event.js';
import type { AgentEvent } from '../../src/agent-events.js';
import type { DisplayMessage } from '../../src/ui/types.js';

describe('reduceAgentEvent', () => {
  it('start → isRunning=true', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'start',
      task: 't',
      model: 'm',
      provider: 'p',
    });
    expect(s.isRunning).toBe(true);
  });

  it('start → 记录 currentModel + runStartedAt（MetaLine 数据源，M3.5 Phase 1）', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'start',
      task: 't',
      model: 'glm-4.6',
      provider: 'p',
    });
    expect(s.currentModel).toBe('glm-4.6');
    expect(typeof s.runStartedAt).toBe('number');
  });

  it('completed → assistant 消息带 model + durationMs（MetaLine 数据源）', () => {
    let s = reduceAgentEvent(initialStreamState, {
      type: 'start',
      task: 't',
      model: 'glm-4.6',
      provider: 'p',
    });
    s = reduceAgentEvent(s, { type: 'text_delta', text: '答复' });
    s = reduceAgentEvent(s, {
      type: 'completed',
      rounds: 1,
      toolCalls: 0,
      reason: 'done',
    });
    const asst = s.completedMessages.find((m) => m.kind === 'assistant');
    expect(asst?.kind === 'assistant' && asst.model).toBe('glm-4.6');
    expect(asst?.kind === 'assistant' && typeof asst.durationMs).toBe('number');
    expect(asst?.kind === 'assistant' && (asst.durationMs ?? -1)).toBeGreaterThanOrEqual(0);
  });

  it('text_delta → 累加到 streamingText', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'text_delta', text: '你好' });
    s = reduceAgentEvent(s, { type: 'text_delta', text: '世界' });
    expect(s.streamingText).toBe('你好世界');
  });

  it('tool_call_start → 加入 activeTools', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start',
      id: 't1',
      name: 'bash',
    });
    expect(s.activeTools).toHaveLength(1);
    expect(s.activeTools[0].id).toBe('t1');
    expect(s.activeTools[0].name).toBe('bash');
    expect(typeof s.activeTools[0].startedAt).toBe('number');
  });

  it('tool_result → 移出 activeTools + 落地 completedMessages(kind:tool)', () => {
    let s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start',
      id: 't1',
      name: 'bash',
    });
    s = reduceAgentEvent(s, {
      type: 'tool_result',
      id: 't1',
      name: 'bash',
      content: 'ok',
      isError: false,
    });
    expect(s.activeTools).toHaveLength(0);
    const tool = s.completedMessages.find((m) => m.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool?.kind === 'tool' && tool.content).toBe('ok');
    expect(tool?.kind === 'tool' && tool.isError).toBe(false);
  });

  it('tool_call_start → activeTools 记录 input（动态区 ToolRunning 摘要用，§9.5）', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start',
      id: 't1',
      name: 'bash',
      input: { command: 'npm test' },
    });
    expect(s.activeTools[0].input).toEqual({ command: 'npm test' });
  });

  it('tool_call_start → streamingText 落地 assistant + 清空（防跨轮累加 #2）', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'text_delta', text: '第一句' });
    expect(s.streamingText).toBe('第一句');
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't1', name: 'bash', input: { command: 'ls' } });
    expect(s.streamingText).toBeNull(); // 清空，不再堆动态区
    const asst = s.completedMessages.find((m) => m.kind === 'assistant');
    expect(asst?.kind === 'assistant' && asst.text).toBe('第一句'); // 落地历史
    expect(s.activeTools[0].id).toBe('t1'); // activeTools 仍正常追加
    // 下一轮新 text 不累加旧的（#2 核心：跨轮不拼接）
    s = reduceAgentEvent(s, { type: 'text_delta', text: '第二句' });
    expect(s.streamingText).toBe('第二句');
  });

  it('tool_call_start 无 streamingText → 不落地空 assistant', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start',
      id: 't1',
      name: 'bash',
    });
    expect(s.completedMessages.find((m) => m.kind === 'assistant')).toBeUndefined();
    expect(s.activeTools).toHaveLength(1);
  });

  it('tool_result → DisplayMessage 携带 input（历史区摘要 §9.5）', () => {
    let s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start',
      id: 't1',
      name: 'bash',
      input: { command: 'npm test' },
    });
    s = reduceAgentEvent(s, {
      type: 'tool_result',
      id: 't1',
      name: 'bash',
      content: 'ok',
      isError: false,
      input: { command: 'npm test' },
    });
    const tool = s.completedMessages.find((m) => m.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.input).toEqual({ command: 'npm test' });
  });

  it('tool_result 未带 input → 从 activeTool 补全（容错：事件缺字段时不丢摘要）', () => {
    let s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start',
      id: 't1',
      name: 'bash',
      // 用非搜索类命令：折叠延迟冻结会把搜索类 bash(如 ls)挂起进 pending，
      // 此处专测 input 补全，故避开挂起走 completedMessages 旧路径。
      input: { command: 'npm run build' },
    });
    s = reduceAgentEvent(s, {
      type: 'tool_result',
      id: 't1',
      name: 'bash',
      content: 'ok',
      isError: false,
      // 故意不传 input：reducer 应从 activeTool 回填
    });
    const tool = s.completedMessages.find((m) => m.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.input).toEqual({ command: 'npm run build' });
  });

  it('permission_request → pendingPermission 挂起', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'permission_request',
      toolUseId: 't1',
      toolName: 'bash',
      input: { command: 'rm -rf x' },
    });
    expect(s.pendingPermission?.toolName).toBe('bash');
    expect(s.pendingPermission?.input.command).toBe('rm -rf x');
  });

  it('completed(done) → streamingText 落地为 assistant 消息 + 清空 + isRunning=false', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'text_delta', text: '答复' });
    s = reduceAgentEvent(s, {
      type: 'completed',
      rounds: 1,
      toolCalls: 0,
      reason: 'done',
    });
    expect(s.streamingText).toBeNull();
    expect(s.isRunning).toBe(false);
    const asst = s.completedMessages.find((m) => m.kind === 'assistant');
    expect(asst?.kind === 'assistant' && asst.text).toBe('答复');
  });

  it('completed 但无 streamingText → 不落地空 assistant 消息', () => {
    const s = reduceAgentEvent(initialStreamState, {
      type: 'completed',
      rounds: 1,
      toolCalls: 0,
      reason: 'done',
    });
    expect(s.completedMessages.find((m) => m.kind === 'assistant')).toBeUndefined();
  });

  it('usage → 累加 token（↑↓ 费用用累计值）', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'usage', inputTokens: 100, outputTokens: 10 });
    s = reduceAgentEvent(s, { type: 'usage', inputTokens: 50, outputTokens: 5 });
    expect(s.usage).toEqual({ inputTokens: 150, outputTokens: 15 });
  });

  it('usage → latestInputTokens 是 per-call 覆写（非累计，供 Ctx% 用）', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'usage', inputTokens: 1000, outputTokens: 10 });
    expect(s.latestInputTokens).toBe(1000);
    s = reduceAgentEvent(s, { type: 'usage', inputTokens: 800, outputTokens: 5 });
    expect(s.latestInputTokens).toBe(800); // 覆写为最新一轮，不是 1800
    expect(s.usage.inputTokens).toBe(1800); // 累计仍正确
  });

  it('warning → 落地 kind:warning 消息', () => {
    const s = reduceAgentEvent(initialStreamState, { type: 'warning', message: '上下文已压缩' });
    expect(s.completedMessages.some((m) => m.kind === 'warning')).toBe(true);
  });

  it('error → 落地 kind:error + isRunning=false', () => {
    const s = reduceAgentEvent(initialStreamState, { type: 'error', error: 'boom' });
    expect(s.isRunning).toBe(false);
    expect(s.error).toBe('boom');
    expect(s.completedMessages.some((m) => m.kind === 'error')).toBe(true);
  });

  it('不可变性：不修改原 state（返回新对象）', () => {
    const before = initialStreamState;
    reduceAgentEvent(before, { type: 'text_delta', text: 'x' });
    expect(before.streamingText).toBeNull(); // 原对象未被改
    expect(before.completedMessages).toHaveLength(0);
  });
});

// ---- 折叠组延迟冻结（reduce-agent-event 挂起连续只读工具，破坏时合并 flush）----
// 详见 docs/详设/20260806220000_折叠组延迟冻结-详设.md

describe('flushReadSearch（延迟冻结合并纯函数）', () => {
  it('空 pending → 无操作', () => {
    const r = flushReadSearch(initialStreamState);
    expect(r.completedMessages).toEqual([]);
    expect(r.pendingReadSearch).toEqual([]);
  });

  it('单条只读 → 直通进 completedMessages（不合并，避免 "Read 1 files"）', () => {
    const tool: DisplayMessage = { kind: 'tool', id: 't1', name: 'read_file', content: 'x', isError: false };
    const r = flushReadSearch({ ...initialStreamState, pendingReadSearch: [tool] });
    expect(r.completedMessages).toEqual([tool]);
    expect(r.pendingReadSearch).toEqual([]);
  });

  it('多条只读 → 合并成 tool_group（tools 保留 name/content）', () => {
    const tools: DisplayMessage[] = [
      { kind: 'tool', id: 't1', name: 'read_file', content: 'a', isError: false },
      { kind: 'tool', id: 't2', name: 'read_file', content: 'b', isError: false },
      { kind: 'tool', id: 't3', name: 'grep', content: 'c', isError: false },
    ];
    const r = flushReadSearch({ ...initialStreamState, pendingReadSearch: tools });
    expect(r.completedMessages).toHaveLength(1);
    expect(r.pendingReadSearch).toEqual([]);
    const group = r.completedMessages[0];
    expect(group.kind).toBe('tool_group');
    if (group.kind === 'tool_group') {
      expect(group.tools).toHaveLength(3);
      expect(group.tools.map((t) => t.name)).toEqual(['read_file', 'read_file', 'grep']);
      expect(group.tools.map((t) => t.content)).toEqual(['a', 'b', 'c']);
      expect(group.id).toMatch(/^m\d+$/);
    }
  });

  it('已有 completedMessages → group 追加在后（不丢历史）', () => {
    const prior: DisplayMessage = { kind: 'tool', id: 'e1', name: 'edit_file', content: 'd', isError: false };
    const r = flushReadSearch({
      ...initialStreamState,
      completedMessages: [prior],
      pendingReadSearch: [
        { kind: 'tool', id: 't1', name: 'read_file', content: 'a', isError: false },
        { kind: 'tool', id: 't2', name: 'read_file', content: 'b', isError: false },
      ],
    });
    expect(r.completedMessages).toHaveLength(2);
    expect(r.completedMessages[0]).toEqual(prior);
    expect(r.completedMessages[1].kind).toBe('tool_group');
  });
});

describe('延迟冻结：tool_result 挂起 + 破坏时机 flush', () => {
  it('read_file result → 挂起 pendingReadSearch，不进 completedMessages', () => {
    let s = reduceAgentEvent(initialStreamState, {
      type: 'tool_call_start', id: 't1', name: 'read_file', input: { path: 'a.ts' },
    });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    expect(s.pendingReadSearch).toHaveLength(1);
    expect(s.completedMessages.find((m) => m.kind === 'tool')).toBeUndefined();
  });

  it('连续 2 个 read_file → 挂起累加（pending=2，completed 仍无 tool）', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't2', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'read_file', content: 'b', isError: false });
    expect(s.pendingReadSearch).toHaveLength(2);
    expect(s.completedMessages.find((m) => m.kind === 'tool')).toBeUndefined();
  });

  it('bash 搜索类(ls)→ 挂起；非搜索(npm test)→ 进 completedMessages', () => {
    // 搜索类 ls → 挂起
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'bash', input: { command: 'ls' } });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'bash', content: 'x', isError: false, input: { command: 'ls' } });
    expect(s.pendingReadSearch).toHaveLength(1);
    expect(s.completedMessages.find((m) => m.kind === 'tool')).toBeUndefined();
    // 非搜索 npm test → 进 completedMessages
    s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't2', name: 'bash', input: { command: 'npm test' } });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'bash', content: 'y', isError: false, input: { command: 'npm test' } });
    expect(s.pendingReadSearch).toHaveLength(0);
    expect(s.completedMessages.find((m) => m.kind === 'tool')).toBeDefined();
  });

  it('非只读 edit_file result → 先 flush 挂起组，edit 也进 completedMessages', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't2', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'read_file', content: 'b', isError: false });
    // pending=2，edit 破坏组
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't3', name: 'edit_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't3', name: 'edit_file', content: 'diff', isError: false });
    expect(s.pendingReadSearch).toHaveLength(0);
    expect(s.completedMessages.find((m) => m.kind === 'tool_group')).toBeDefined();
    expect(s.completedMessages.find((m) => m.kind === 'tool' && m.name === 'edit_file')).toBeDefined();
  });

  it('text_delta 破坏挂起组 → flush 成 tool_group + 累加 streamingText', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't2', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'read_file', content: 'b', isError: false });
    s = reduceAgentEvent(s, { type: 'text_delta', text: '答复' });
    expect(s.pendingReadSearch).toHaveLength(0);
    expect(s.completedMessages.find((m) => m.kind === 'tool_group')).toBeDefined();
    expect(s.streamingText).toBe('答复');
  });

  it('单条只读 + text_delta → 直通进 completed（不合并成 group，避免 "Read 1 files"）', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'text_delta', text: '答复' });
    expect(s.pendingReadSearch).toHaveLength(0);
    expect(s.completedMessages.find((m) => m.kind === 'tool')).toBeDefined();
    expect(s.completedMessages.find((m) => m.kind === 'tool_group')).toBeUndefined();
  });

  it('completed 破坏挂起组 → group 在前，assistant 在后', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't2', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'read_file', content: 'b', isError: false });
    s = reduceAgentEvent(s, { type: 'text_delta', text: '答复' });
    s = reduceAgentEvent(s, { type: 'completed', rounds: 1, toolCalls: 2, reason: 'done' });
    const kinds = s.completedMessages.map((m) => m.kind);
    expect(kinds).toContain('tool_group');
    expect(kinds).toContain('assistant');
    expect(kinds.indexOf('tool_group')).toBeLessThan(kinds.indexOf('assistant'));
  });

  it('warning 破坏挂起组', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't2', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'read_file', content: 'b', isError: false });
    s = reduceAgentEvent(s, { type: 'warning', message: '压缩' });
    expect(s.pendingReadSearch).toHaveLength(0);
    expect(s.completedMessages.find((m) => m.kind === 'tool_group')).toBeDefined();
    expect(s.completedMessages.find((m) => m.kind === 'warning')).toBeDefined();
  });

  it('error 破坏挂起组', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'tool_call_start', id: 't1', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't1', name: 'read_file', content: 'a', isError: false });
    s = reduceAgentEvent(s, { type: 'tool_call_start', id: 't2', name: 'read_file' });
    s = reduceAgentEvent(s, { type: 'tool_result', id: 't2', name: 'read_file', content: 'b', isError: false });
    s = reduceAgentEvent(s, { type: 'error', error: 'boom' });
    expect(s.pendingReadSearch).toHaveLength(0);
    expect(s.completedMessages.find((m) => m.kind === 'tool_group')).toBeDefined();
  });
});
