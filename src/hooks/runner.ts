// Hooks（支点 12）执行器：spawn hook command → 喂 payload JSON → 解析输出。
//
// 解析协议（CC，联网核实见 M5-方案解析 §3 + 文档审阅清单 I14）：
//   ① exit code 2 = deny（stderr 当 reason）
//   ② stdout 顶层 JSON {decision:"approve"|"block", reason}
//   ③ 结构化 hookSpecificOutput（CC #48760：permissionDecision 顶层平铺会被静默丢弃，必须嵌套）
// 多 hook 决策取最严格（deny > allow），由 inject.ts 聚合；本模块只解析单 hook。
// 超时/失败默认 allow（系统级降级，不杀 agent）。
import { spawn } from 'node:child_process';
import type { HookDef, HookResult, HookPayload } from './types.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 可注入的 shell 执行器（测试用 mock；生产用默认 spawn）。stdin 喂 payload JSON。 */
export type ShellExec = (
  command: string,
  stdin: string,
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

/** 默认超时：hook 跑太久默认放行（不阻塞 agent）。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 纯解析 hook 输出（CC 协议三通道）。无 I/O，全场景可单测。
 * exit 2 → deny；stdout JSON（嵌套优先 / 顶层次之）→ 决策；其余 → allow。
 */
export function parseHookOutput(stdout: string, exitCode: number, stderr = ''): HookResult {
  // ① exit code 2 = deny（stderr 当 reason）
  if (exitCode === 2) {
    return { decision: 'deny', reason: stderr.trim() || 'hook denied (exit code 2)' };
  }

  // ②③ stdout JSON（结构化嵌套优先，顶层 decision 次之）
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      // ③ 结构化嵌套（CC #48760：permissionDecision 顶层平铺会被静默丢弃，必须 hookSpecificOutput 下）
      const hso = obj.hookSpecificOutput as Record<string, unknown> | undefined;
      if (hso && typeof hso === 'object') {
        const pd = hso.permissionDecision;
        if (pd === 'deny' || pd === 'ask') {
          return {
            decision: 'deny',
            reason:
              (hso.permissionDecisionReason as string | undefined) ??
              (pd === 'ask' ? 'hook 要求询问' : 'hook denied'),
          };
        }
        if (pd === 'allow' || pd === 'defer') {
          return {
            decision: 'allow',
            modifiedInput: hso.updatedInput as Record<string, unknown> | undefined,
          };
        }
      }
      // ② 顶层 decision（approve / block）
      const dec = obj.decision;
      if (dec === 'approve') return { decision: 'allow' };
      if (dec === 'block') return { decision: 'deny', reason: (obj.reason as string) ?? '' };
    } catch {
      // 非 JSON stdout + 非 exit 2 = 放行（hook 只打了日志）
    }
  }
  return { decision: 'allow' };
}

/**
 * 默认 exec：spawn command（shell:true，跨平台用平台默认 shell）→ 喂 stdin → 收 stdout/stderr/exit。
 * 超时 SIGKILL + 返回 exitCode -1（parseHookOutput 视为放行）。
 * 注：Git Bash 对齐（§9.3）留作后续细化——一期 hook command 由用户按自己环境编写。
 */
const defaultExec: ShellExec = (command, stdin, opts) =>
  new Promise<ExecResult>((resolve) => {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(command, { shell: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // noop
      }
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: -1 }); // 超时 = 放行（降级）
      }
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: -1 }); // spawn 失败 = 放行
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      }
    });
    try {
      child.stdin.write(stdin);
      child.stdin.end();
    } catch {
      // stdin 写失败不致命（hook 仍跑，只是拿不到 payload）
    }
  });

/**
 * 跑一个 hook：spawn command → 喂 payload JSON → 解析输出。
 * spawn 失败/超时 → allow（系统级降级，绝不杀 agent）。exec 可注入（测试）。
 */
export async function runHook(
  def: HookDef,
  payload: HookPayload,
  deps: { exec?: ShellExec; timeoutMs?: number } = {},
): Promise<HookResult> {
  const exec = deps.exec ?? defaultExec;
  try {
    const r = await exec(def.command, JSON.stringify(payload), {
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return parseHookOutput(r.stdout, r.exitCode, r.stderr);
  } catch {
    return { decision: 'allow' }; // 注入 exec 抛错时降级（默认 exec 不抛，只 resolve -1）
  }
}
