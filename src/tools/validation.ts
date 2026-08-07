// P0-5 后置验证：edit_file/write_file 成功后自动跑 build/test，失败回喂 LLM（M4 Phase4 + 详设 §四）。
// 设计原则：
//   - 降级优先：验证失败/超时/命令缺失都不杀 agent，仅把错误输出回喂 LLM 让其修复。
//   - 零配置：config.validation.enabled 默认 true；探测不到项目类型视为通过（不强加验证）。
//   - 可测性：runValidation 接受可选 runCmd 注入，生产用 spawn 默认实现，单测 mock。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { isValidationEnabled } from '../providers/config.js';

/** 单命令超时上限（ms）。验证拖慢体验的兜底——超时降级为失败回喂，不卡死 agent loop。 */
const COMMAND_TIMEOUT_MS = 60_000;
/** 退出码约定：命令超时被 kill 时用 124（对齐 coreutils timeout）。 */
const TIMEOUT_EXIT_CODE = 124;
/** edit/write 后触发验证的工具白名单（delete_file/move 不验证——删/移不改语法正确性，徒增噪音）。 */
const VALIDATED_TOOLS = new Set(['edit_file', 'write_file']);

export type ProjectType = 'typescript' | 'node' | 'python' | 'unknown';

export interface ValidationResult {
  success: boolean;
  output: string; // 编译/测试输出（失败时回喂给 LLM）
  command: string; // 实际执行的命令（失败的那条）
  duration: number; // 耗时（ms）
}

/** 命令执行器契约（可注入，便于单测 mock；生产用默认 spawn 实现）。 */
export type CommandRunner = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 读 package.json 的 scripts 键集合（解析失败/无文件降级为空集）。 */
function readPackageScripts(projectRoot: string): Set<string> {
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return new Set();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set(); // 解析失败降级为空（不阻断验证）
  }
}

/** 探测项目类型：tsconfig.json 优先于 package.json（TS 是 Node 超集，先匹配更精确的类型）。 */
export function detectProjectType(projectRoot: string): ProjectType {
  if (existsSync(join(projectRoot, 'tsconfig.json'))) return 'typescript';
  if (existsSync(join(projectRoot, 'package.json'))) return 'node';
  if (existsSync(join(projectRoot, 'pyproject.toml')) || existsSync(join(projectRoot, 'setup.py'))) return 'python';
  return 'unknown';
}

/**
 * 生成验证命令序列：编译检查优先，测试次之。
 * 优先复用项目已有 scripts（build/test），缺失才用兜底命令（tsc --noEmit / py_compile）。
 * 顺序执行时第一步失败即提前返回，故编译错误不会浪费在跑测试上。
 */
export function getValidationCommands(projectType: ProjectType, projectRoot: string): string[] {
  const scripts = readPackageScripts(projectRoot);
  const commands: string[] = [];
  switch (projectType) {
    case 'typescript':
      commands.push(scripts.has('build') ? 'npm run build' : 'npx tsc --noEmit');
      break;
    case 'python':
      commands.push('python -m py_compile .');
      break;
    case 'node':
    case 'unknown':
      break; // 纯 JS 无编译步骤；unknown 无从探测
  }
  // 通用第二步：有 test script → 追加测试（typescript/node）
  if (projectType !== 'python' && scripts.has('test')) {
    commands.push('npm test');
  }
  return commands;
}

/** 默认命令执行器：spawn + 超时 kill + 捕获 stdout/stderr。 */
const defaultRunCmd: CommandRunner = (cmd, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, { cwd: opts.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: TIMEOUT_EXIT_CODE, stdout, stderr: `${stderr}\n(命令超时 ${opts.timeoutMs}ms，已终止)` });
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });

/**
 * 执行验证：顺序跑命令，任一失败立即返回（不继续后续步骤）。
 * runCmd 抛异常或命令非零退出都降级为 success:false（不向上抛，保 agent loop 不崩）。
 */
export async function runValidation(
  projectRoot: string,
  options: { skipTests?: boolean; skipLint?: boolean; runCmd?: CommandRunner } = {},
): Promise<ValidationResult> {
  const runCmd = options.runCmd ?? defaultRunCmd;
  const projectType = detectProjectType(projectRoot);
  let commands = getValidationCommands(projectType, projectRoot);
  if (options.skipTests) commands = commands.filter((c) => !c.startsWith('npm test'));
  if (options.skipLint) commands = commands.filter((c) => !c.includes('lint'));
  if (commands.length === 0) {
    return { success: true, output: '', command: '', duration: 0 };
  }
  let totalDuration = 0;
  for (const cmd of commands) {
    const start = Date.now();
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await runCmd(cmd, { cwd: projectRoot, timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (err) {
      // runCmd 抛异常（如 spawn ENOENT）→ 降级为失败，输出含异常信息
      return {
        success: false,
        command: cmd,
        duration: Date.now() - start,
        output: `验证命令执行异常: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    totalDuration += Date.now() - start;
    if (res.code !== 0) {
      const output = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join('\n') || '(命令失败但无输出)';
      return { success: false, command: cmd, duration: totalDuration, output };
    }
  }
  return { success: true, command: commands.join(' && '), output: '', duration: totalDuration };
}

/**
 * edit/write 后触发验证的集成层接口（agent.ts 在 executeTool 后调用）。
 * 职责：config 开关 + 工具白名单 + 委托 runValidation。
 * 返回 null = 跳过（关/非编辑工具/验证通过）；返回 ValidationResult = 验证失败（回喂 LLM）。
 */
export async function validateAfterEdit(
  toolName: string,
  projectRoot: string,
  options: { runCmd?: CommandRunner } = {},
): Promise<ValidationResult | null> {
  if (!isValidationEnabled()) return null; // 用户关闭验证
  if (!VALIDATED_TOOLS.has(toolName)) return null; // 非编辑工具不验证
  const result = await runValidation(projectRoot, options);
  return result.success ? null : result;
}
