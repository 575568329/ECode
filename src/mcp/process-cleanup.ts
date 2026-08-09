// MCP（支点 10）进程树清理 —— stdio server 断开时杀整棵进程树（含 npx→node 孙子）。
//
// 核心结论（已核实 SDK stdio.js:65-75 / 143-178，详设 §5）：
//   - SDK StdioClientTransport.spawn 无 detached:true → POSIX 进程组方案失效。
//   - SDK close() 只 kill 直接 child，不杀孙子（npx→node 孙子残留）。
//   - win32: taskkill /T /F /PID 基于 Windows 内核进程父子关系表递归杀整树。
//   - POSIX: pgrep -P BFS 遍历进程树逐个 SIGTERM（借鉴 opencode，运行时自探测，
//     不依赖 spawn 时设 detached；pgrep 缺失/进程已退出 → 优雅降级当无子）。
//
// 触发点：McpManager.disconnect/disconnectAll/reconnect（SDK close 之后兜底杀孙子）。
// taskkill/pgrep 由 ECode 自己 spawn，不经 RCE 白名单校验（白名单只管用户 entry.command）。
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
 * 查询一个进程的直接子进程 pid 列表（POSIX：pgrep -P）。
 * - 解析 stdout 每行一个 pid，非数字行忽略。
 * - pgrep 不存在 / 任意异常 → resolve []（优雅降级：当无子，不阻塞主流程）。
 *
 * 抽成独立函数便于单测注入，且不依赖 spawn 时记录 pgid（运行时自探测，呼应 §1.1）。
 */
export async function pgrepChildren(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    let settled = false;
    const settle = (result: number[]): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on('error', () => settle([])); // pgrep 缺失（ENOENT）→ 当无子
    child.on('close', () => {
      const pids: number[] = [];
      for (const line of stdout.split('\n')) {
        const n = parseInt(line, 10);
        if (!Number.isNaN(n)) pids.push(n);
      }
      settle(pids);
    });
  });
}

/**
 * BFS 遍历进程树，收集 rootPid 的所有后代 pid（不含 rootPid 自身）。
 * - getChildren 可注入（默认 pgrepChildren），便于纯逻辑测试。
 * - seen 集合去重 + 成环防护（异常进程树出现环时不死循环）。
 *
 * 返回顺序为 BFS 层序；调用方倒序 kill 以「先杀深的」避免孤儿。
 */
export async function collectDescendants(
  rootPid: number,
  getChildren: (pid: number) => Promise<number[]> = pgrepChildren,
): Promise<number[]> {
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current === undefined) break;
    const children = await getChildren(current);
    for (const cpid of children) {
      if (!seen.has(cpid)) {
        seen.add(cpid);
        descendants.push(cpid);
        queue.push(cpid);
      }
    }
  }
  return descendants;
}

/**
 * 兜底杀进程树（在 SDK transport.close() 之后调用，清理 SDK 杀不到的孙子进程）。
 * 直接 child（transport.pid）由 SDK close 兜底；本函数只负责后代。
 *
 * - win32: taskkill /T /F /PID 杀整树（/T 递归子进程树，基于 Windows 内核进程父子关系表）。
 *   幂等：进程已退出时 taskkill 返回错误码，忽略（on close 即 resolve）。
 * - POSIX: pgrep -P BFS 遍历后代 → 倒序 SIGTERM（先杀深的）。pgrep 缺失/kill 失败均静默降级。
 *
 * @param pid stdio child pid（McpConnection.pid）；null/undefined → no-op
 * @param platform 测试注入；默认 detectPlatform()
 */
export async function killProcessTree(
  pid: number | null | undefined,
  platform: Platform = detectPlatform(),
): Promise<void> {
  if (!pid) return;

  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      spawn(taskkillPath(), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
        .on('close', () => resolve()); // 错误码 ignore（进程已退出 → taskkill 返回非 0，不影响）
    });
    return;
  }

  // POSIX：pgrep 树遍历杀后代（直接 child 由 SDK close 兜底）
  const descendants = await collectDescendants(pid);
  for (let i = descendants.length - 1; i >= 0; i--) {
    const dpid = descendants[i];
    if (dpid === undefined) continue;
    try {
      process.kill(dpid, 'SIGTERM');
    } catch {
      // 进程已退出（ESRCH）或权限不足 → 忽略，继续杀其他后代
    }
  }
}
