import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ToolResult } from './types.js';
import { truncate } from './truncate.js';

/** 命令超时（ms）：30s→120s，治 #4——全量 vitest 在 Windows 超 30s 被误杀 ETIMEDOUT。
 *  异步化后超时只杀子进程，不再阻塞主线程（治 #3 UI 卡死）。 */
const BASH_TIMEOUT_MS = 120_000;

/**
 * 检测 Windows 上可用的 Git Bash（真 POSIX shell）路径。
 * 有 → Unix 命令（find/grep/head/tail）可直接跑，输出 UTF-8；
 * 无 → 回退 cmd.exe（LLM 应已按 system-prompt 的 Platform 用 Windows 命令）。
 *
 * §9.3：不裸调 wsl/powershell；用 where（System32，在 PATH）查 bash.exe，
 * 取含 `\Git\` 的真 Git Bash，避开 WindowsApps 的 WSL 伪入口。失败优雅降级（返回 null）。
 * 注意：硬编码常见路径不可靠（本项目 git 装在 D:\Tool\Git 而非 Program Files），故走 where。
 */
function detectGitBash(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('where', ['bash.exe'], { encoding: 'utf-8', timeout: 3000 });
    if (r.status !== 0 || !r.stdout) return null;
    const lines = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.find((l) => /\\Git\\/i.test(l) && existsSync(l)) ?? null;
  } catch {
    return null;
  }
}

/** 进程内缓存检测结果（平台 / shell 安装在进程生命周期内不变）。 */
let gitBashCache: string | null | undefined;
function getGitBash(): string | null {
  if (gitBashCache === undefined) gitBashCache = detectGitBash();
  return gitBashCache;
}

/**
 * 返回 executeBash 实际使用的 shell 描述（供 system-prompt 告知 LLM 用哪种命令语法）。
 * 关键：与执行层保持一致——有 Git Bash 时提示 POSIX（LLM 用 ls/find/grep），
 * 否则 cmd（LLM 用 dir/findstr）。避免「prompt 说 win32 但实际跑 bash」导致 dir 进 bash 不认。
 */
export function getShellInfo(): { shell: string; posix: boolean } {
  const isWin = process.platform === 'win32';
  const gitBash = isWin ? getGitBash() : null;
  if (gitBash) return { shell: 'bash (Git Bash, POSIX)', posix: true };
  if (isWin) return { shell: 'cmd.exe (Windows)', posix: false };
  return { shell: '/bin/sh (POSIX)', posix: true };
}

/**
 * 异步执行 shell 命令（child_process.spawn，不阻塞主线程 → 治 #3 UI 卡死）。
 *
 * 跨平台策略（用户选「两者结合」）：
 *   - Windows + 有 Git Bash → bash -c <command>（POSIX：find/grep/head 可用，UTF-8）
 *   - Windows + 无 Git Bash → cmd /c "chcp 65001 & <command>"（强制 UTF-8 代码页 → 治 #5 乱码）
 *   - 非 Windows            → /bin/sh -c <command>
 *
 * 失败时 stderr 优先（对 agent 排错有用）；超时杀子进程并返回已收集的部分输出。
 */
export async function executeBash(input: { command: string }): Promise<ToolResult> {
  const { command } = input;
  const isWin = process.platform === 'win32';
  const gitBash = isWin ? getGitBash() : null;

  // 选 shell：Git Bash 优先（POSIX 兼容），否则平台默认
  let shell: string;
  let shellArgs: string[];
  if (gitBash) {
    shell = gitBash;
    shellArgs = ['-c', command];
  } else if (isWin) {
    shell = 'cmd.exe';
    // chcp 65001 切 UTF-8 代码页（>nul 隐藏 chcp 自身输出），再跑命令 → 治 #5 GBK 乱码
    shellArgs = ['/c', `chcp 65001 >nul & ${command}`];
  } else {
    shell = '/bin/sh';
    shellArgs = ['-c', command];
  }

  return new Promise<ToolResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true, // Windows 下不弹 cmd 黑窗
      });
    } catch (err) {
      resolve({
        content: `启动 shell 失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // settled 防重：close 与 timeout 可能竞争，保证只 resolve 一次
    let settled = false;
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const partial = Buffer.concat(stdoutChunks).toString('utf-8');
      finish({
        content: truncate(partial || `命令超时（${BASH_TIMEOUT_MS / 1000}s）被终止`),
        isError: true,
      });
    }, BASH_TIMEOUT_MS);

    child.on('error', (err) => finish({ content: `执行失败: ${err.message}`, isError: true }));

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code !== 0) {
        const detail = (stderr || stdout).trim();
        finish({ content: truncate(detail || `命令以退出码 ${code} 结束`), isError: true });
      } else {
        finish({ content: truncate(stdout), isError: false });
      }
    });
  });
}
