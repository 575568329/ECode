// 统一退出：先清理 MCP 子进程树，再 process.exit。
//
// 根因（debugging #019）：disconnectAll 原只挂 React useEffect cleanup
//（use-agent-stream.ts:230），而 REPL 所有退出入口（app.tsx 双击 Ctrl+C / /exit）
// 都走 process.exit(0) —— 直接终止 Node，跳过 React 异步 cleanup → MCP server
//（npx→node 两层）子进程残留累积，后台 node 进程越堆越多。
//
// CLI 模式（--list-models/--sessions/one-shot/--continue/usage）不加载 MCP
//（getMcpManagerOrNull 返回 null）→ shutdown no-op，安全。
import { getMcpManagerOrNull } from './mcp/manager.js';

/** disconnectAll 超时上限：防 SDK close 卡死（MCP server 不响应 close 时退出永不返回）。 */
const MCP_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * 统一退出：尽力清理 MCP 子进程（带超时兜底）后 process.exit。
 *
 * 多端适配：
 * - REPL 退出（双击 Ctrl+C / /exit）：disconnectAll → exit（核心修复）。
 * - CLI 模式：未加载 MCP → null 分支直接 exit，无副作用。
 * - 超时兜底：disconnectAll race 一个定时器，宁可残留也别卡死用户终端
 *   （子进程已由 killProcessTree 的 win32 taskkill / POSIX pgrep 尽力杀）。
 *
 * @param code 退出码（0 正常 / 1 异常）。
 */
export async function shutdown(code = 0): Promise<never> {
  const manager = getMcpManagerOrNull();
  // fast-path：无活跃连接（CLI 模式 / REPL 未连 MCP / 测试环境）→ 跳过 async 清理，
  // process.exit 同步触发（保持退出回调同步语义，避免 fire-and-forget 把 exit 推到微任务）。
  // 仅有连接时才 await 清理（防 MCP 子进程泄漏，debugging #019）。
  if (manager && manager.hasActiveConnections()) {
    // race 超时：disconnectAll 卡住时也要能退（3s 后强制 exit）。
    await Promise.race([
      manager.disconnectAll().catch(() => {
        // 清理失败不阻塞退出（尽力而为；进程树清理已兜底）
      }),
      new Promise<void>((resolve) => setTimeout(resolve, MCP_SHUTDOWN_TIMEOUT_MS)),
    ]);
  }
  process.exit(code);
}
