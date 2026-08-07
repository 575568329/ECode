// validation.test.ts —— P0-5 后置验证单元测试（M4 Phase4 + 详设 §四）。
// 覆盖：项目类型探测 / 命令生成 / 顺序执行+失败提前返回+降级 / 集成层 config 开关+工具白名单。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mock config：validateAfterEdit 依赖 isValidationEnabled，避免读真实 ~/.ecode/config.json。
vi.mock('../src/providers/config.js', () => ({
  isValidationEnabled: vi.fn(() => true),
}));

import {
  detectProjectType,
  getValidationCommands,
  runValidation,
  validateAfterEdit,
  type CommandRunner,
} from '../src/tools/validation.js';
import { isValidationEnabled } from '../src/providers/config.js';

const mockConfig = vi.mocked(isValidationEnabled);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ecode-val-'));
  mockConfig.mockReturnValue(true); // 重置：上个 it 的 disabled 不泄漏
});

describe('detectProjectType', () => {
  it('tsconfig.json 优先于 package.json → typescript', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(detectProjectType(dir)).toBe('typescript');
  });

  it('仅 package.json → node', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    expect(detectProjectType(dir)).toBe('node');
  });

  it('pyproject.toml → python', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');
    expect(detectProjectType(dir)).toBe('python');
  });

  it('setup.py → python', () => {
    writeFileSync(join(dir, 'setup.py'), 'from setuptools import setup');
    expect(detectProjectType(dir)).toBe('python');
  });

  it('空目录 → unknown', () => {
    expect(detectProjectType(dir)).toBe('unknown');
  });
});

describe('getValidationCommands', () => {
  it('typescript 有 build script → npm run build 优先', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"build":"tsc","test":"vitest"}}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const cmds = getValidationCommands('typescript', dir);
    expect(cmds[0]).toBe('npm run build');
    expect(cmds).toContain('npm test');
  });

  it('typescript 无 build script → 兜底 npx tsc --noEmit', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(getValidationCommands('typescript', dir)[0]).toBe('npx tsc --noEmit');
  });

  it('node 有 test script → npm test', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}');
    expect(getValidationCommands('node', dir)).toEqual(['npm test']);
  });

  it('node 无 test script → 空数组（纯 JS 无从验证）', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    expect(getValidationCommands('node', dir)).toEqual([]);
  });

  it('python → py_compile', () => {
    expect(getValidationCommands('python', dir)).toEqual(['python -m py_compile .']);
  });

  it('unknown → 空数组', () => {
    expect(getValidationCommands('unknown', dir)).toEqual([]);
  });

  it('package.json 解析失败 → scripts 降级为空（不抛）', () => {
    writeFileSync(join(dir, 'package.json'), '{ 不是合法 json');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(getValidationCommands('typescript', dir)[0]).toBe('npx tsc --noEmit');
  });
});

describe('runValidation', () => {
  const okRun: CommandRunner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const failRun: CommandRunner = vi.fn(async (cmd) => ({ code: 1, stdout: '', stderr: `error in ${cmd}` }));

  it('unknown 项目（无命令）→ success:true', async () => {
    const r = await runValidation(dir, { runCmd: okRun });
    expect(r.success).toBe(true);
  });

  it('命令成功 → success:true', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    const r = await runValidation(dir, { runCmd: okRun });
    expect(r.success).toBe(true);
  });

  it('命令失败 → success:false + output + command', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    const r = await runValidation(dir, { runCmd: failRun });
    expect(r.success).toBe(false);
    expect(r.command).toBe('npx tsc --noEmit');
    expect(r.output).toContain('error');
  });

  it('多命令第一个失败 → 提前返回，不跑后续', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"build":"tsc","test":"vitest"}}');
    const localFail: CommandRunner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'fail' }));
    await runValidation(dir, { runCmd: localFail });
    // build + test 两命令；build 失败应只执行 1 次（提前返回）
    expect(localFail).toHaveBeenCalledTimes(1);
  });

  it('runCmd 抛异常 → 降级 success:false，不崩', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    const boom: CommandRunner = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const r = await runValidation(dir, { runCmd: boom });
    expect(r.success).toBe(false);
    expect(r.output).toContain('spawn ENOENT');
  });

  it('skipTests=true → 过滤 npm test', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"build":"tsc","test":"vitest"}}');
    const localRun: CommandRunner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runValidation(dir, { runCmd: localRun, skipTests: true });
    // build 跑，test 被过滤 → 只 1 次调用
    expect(localRun).toHaveBeenCalledTimes(1);
    expect(localRun).toHaveBeenCalledWith('npm run build', expect.anything());
  });
});

describe('validateAfterEdit', () => {
  const okRun: CommandRunner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const failRun: CommandRunner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'compile error' }));

  it('非编辑工具（read_file）→ null（跳过验证）', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    const r = await validateAfterEdit('read_file', dir, { runCmd: okRun });
    expect(r).toBeNull();
  });

  it('edit_file 验证成功 → null', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    const r = await validateAfterEdit('edit_file', dir, { runCmd: okRun });
    expect(r).toBeNull();
  });

  it('write_file 验证失败 → ValidationResult（回喂 LLM）', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    const r = await validateAfterEdit('write_file', dir, { runCmd: failRun });
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
    expect(r!.output).toContain('compile error');
  });

  it('config disabled → null（不验证，即使编辑工具）', async () => {
    mockConfig.mockReturnValue(false);
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const r = await validateAfterEdit('edit_file', dir, { runCmd: failRun });
    expect(r).toBeNull();
  });
});
