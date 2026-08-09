// MCP（支点 10）进程树清理 —— stdio server 断开时杀整棵进程树（含 npx→node 孙子）。
//
// 核心结论（已核实 SDK stdio.js:65-75 / 143-178，详设 §5）：
//   - SDK StdioClientTransport.spawn 无 detached:true → POSIX 进程组方案失效。
//   - SDK close() 只 kill 直接 child，不杀孙子（npx→node 孙子残留）。
//   - win32: taskkill /T /F /PID 基于 Windows 进程父子关系表，能杀整树（不依赖进程组）。
//   - POSIX: 降级 no-op（SDK close 已优雅杀 child；孙子残留=已知限制，详设 §十二）。
//
// 触发点：McpManager.disconnect/disconnectAll/reconnect（SDK close 之后兜底杀孙子）。
// taskkill 由 ECode 自己 spawn（绝对路径），不经 RCE 白名单校验（白名单只管用户 entry.command）。
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** 平台分类（抽纯函数，测试注入；process.platform 是 readonly non-configurable 不可靠 mock）。 */
export type Platform = 'win32' | 'posix';

/** 判断运行平台属于 win32 还是 POSIX 类（linux/darwin）。 */
export function detectPlatform(platform: string = process.platform): Platform {
  return platform === 'win32' ? 'win32' : 'posix';
}

/** Windows taskkill 绝对路径（不依赖 PATH，精简环境 CI/容器不漏）。 */
function taskkillPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * 兜底杀进程树（在 SDK transport.close() 之后调用，清理 SDK 杀不到的孙子进程）。
 *
 * - win32: taskkill /T /F /PID 杀整树（/T 递归子进程树，基于 Windows 进程父子关系表）。
 *   幂等：进程已退出时 taskkill 返回错误码，忽略（on close 即 resolve）。
 * - POSIX: no-op（SDK close 已优雅杀 child；孙子残留=已知限制）。
 *
 * @param pid stdio child pid（McpConnection.pid）；null/undefined → no-op
 * @param platform 测试注入；默认 detectPlatform()
 */
export async function killProcessTree(
  pid: number | null | undefined,
  platform: Platform = detectPlatform(),
): Promise<void> {
  if (!pid) return;
  if (platform !== 'win32') return; // POSIX 降级 no-op

  await new Promise<void>((resolve) => {
    spawn(taskkillPath(), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      .on('close', () => resolve()); // 错误码 ignore（进程已退出 → taskkill 返回非 0，不影响）
  });
}
