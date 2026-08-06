import { describe, it, expect } from 'vitest';
import { reduceAgentEvent, initialStreamState } from '../../src/ui/reduce-agent-event.js';
import type { AgentEvent } from '../../src/agent-events.js';

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
      input: { command: 'ls' },
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
    expect(tool?.kind === 'tool' && tool.input).toEqual({ command: 'ls' });
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

  it('usage → 累加 token', () => {
    let s = reduceAgentEvent(initialStreamState, { type: 'usage', inputTokens: 100, outputTokens: 10 });
    s = reduceAgentEvent(s, { type: 'usage', inputTokens: 50, outputTokens: 5 });
    expect(s.usage).toEqual({ inputTokens: 150, outputTokens: 15 });
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
