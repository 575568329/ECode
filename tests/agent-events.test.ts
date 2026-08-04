import { describe, it, expect } from 'vitest';
import { isTextDeltaEvent, isPermissionRequestEvent, type AgentEvent } from '../src/agent-events.js';

describe('AgentEvent 类型守卫', () => {
  it('isTextDeltaEvent 正确收窄 text_delta 事件', () => {
    const e: AgentEvent = { type: 'text_delta', text: '你好' };
    expect(isTextDeltaEvent(e)).toBe(true);
    if (isTextDeltaEvent(e)) expect(e.text).toBe('你好');
  });

  it('isPermissionRequestEvent 正确收窄 permission_request 事件', () => {
    const e: AgentEvent = {
      type: 'permission_request',
      toolUseId: 'u1',
      toolName: 'bash',
      input: { command: 'rm -rf x' },
    };
    expect(isPermissionRequestEvent(e)).toBe(true);
  });

  it('非匹配类型返回 false', () => {
    const e: AgentEvent = { type: 'completed', rounds: 1, toolCalls: 0, reason: 'done' };
    expect(isTextDeltaEvent(e)).toBe(false);
  });
});
