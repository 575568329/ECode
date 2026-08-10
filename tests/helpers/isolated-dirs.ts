/**
 * 集成测试隔离根目录 helper。
 *
 * 为什么需要：runAgentStream 内部会落盘 session（saveSession）和写 runtime-log（initRuntimeLog）。
 * 若不隔离，集成测试会污染真实 `.ecode/sessions/`（曾累积 3800+ 文件，混入 `跑.json`/`死循环.json`
 * 等测试产物）和真实 `docs/logs/runtime/`，与项目实际运行的日志/会话混淆。
 *
 * 用法（每个集成测试文件）：
 *   let root: string;
 *   beforeEach(() => { root = makeIsolatedRoot(); });
 *   afterEach(() => { rmSync(root, { recursive: true, force: true }); });
 *   runAgentStream('跑', { provider, ...isolatedOpts(root) });
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 创建一次性隔离根目录（tmpdir 下，调用方负责 afterEach 清理）。 */
export function makeIsolatedRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ecode-test-'));
}

/**
 * 返回 runAgentStream 的隔离 opts 片段：session 落盘 + runtime-log 都写到 root 下，
 * 不碰真实数据目录。与其它 opts（provider/permissionGate/...）展开合并即可。
 */
export function isolatedOpts(root: string): { sessionBaseDir: string; runtimeLogBaseDir: string } {
  return { sessionBaseDir: root, runtimeLogBaseDir: root };
}
