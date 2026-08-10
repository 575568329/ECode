// runtime-logger 测试：聚焦 warning 日志（#4 降级排查依据）。
// 隔离：initRuntimeLog 的 baseDir 传 tmpdir，日志写到临时目录，不污染真实 docs/logs/runtime/。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRuntimeLog, logWarning } from '../src/runtime-logger.js';

describe('logWarning', () => {
  let root = '';
  let logPath = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
    logPath = '';
  });

  it('写入 ⚠️ warning 段落（含 source 标签与 message）', () => {
    root = mkdtempSync(join(tmpdir(), 'ecode-rtlog-'));
    logPath = initRuntimeLog('test-task', 'test-model', undefined, root);
    logWarning('subagent-route', '跨 provider 降级：落点失败，回退主 provider');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('⚠️');
    expect(content).toContain('[subagent-route]');
    expect(content).toContain('跨 provider 降级');
  });
});
