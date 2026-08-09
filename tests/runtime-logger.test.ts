// runtime-logger 测试：聚焦 warning 日志（#4 降级排查依据）。
// initRuntimeLog 写真实 docs/logs/runtime/，用例后清理生成的 .md（目录留空不影响 git）。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { initRuntimeLog, logWarning } from '../src/runtime-logger.js';

describe('logWarning', () => {
  let logPath = '';
  afterEach(() => {
    // 清理本用例生成的日志文件（避免 docs/logs/runtime 累积测试垃圾）
    if (logPath && existsSync(logPath)) {
      try {
        unlinkSync(logPath);
      } catch {
        // 静默：清理失败不阻断测试
      }
    }
    logPath = '';
  });

  it('写入 ⚠️ warning 段落（含 source 标签与 message）', () => {
    logPath = initRuntimeLog('test-task', 'test-model');
    logWarning('subagent-route', '跨 provider 降级：落点失败，回退主 provider');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('⚠️');
    expect(content).toContain('[subagent-route]');
    expect(content).toContain('跨 provider 降级');
  });
});
