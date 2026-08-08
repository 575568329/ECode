import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import {
  isInside,
  isExternalDirectory,
  isDangerousFile,
  checkPathSafety,
} from '../../src/permission/path-guard.js';

describe('isInside', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `ecode-pg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('工作区内文件 → true', () => {
    expect(isInside(join(root, 'src', 'a.ts'), root)).toBe(true);
  });

  it('多层子目录文件 → true', () => {
    expect(isInside(join(root, 'a', 'b', 'c.txt'), root)).toBe(true);
  });

  it('越界 ../escape → false', () => {
    expect(isInside(join(root, '..', 'escape.txt'), root)).toBe(false);
  });

  it('完全独立的目录 → false', () => {
    const other = join(tmpdir(), `ecode-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(isInside(join(other, 'x.txt'), root)).toBe(false);
  });

  it('根自身 → true（边界）', () => {
    expect(isInside(root, root)).toBe(true);
  });
});

describe('isDangerousFile', () => {
  it('.env → true（敏感凭据）', () => {
    expect(isDangerousFile(join('project', '.env'))).toBe(true);
  });

  it('.env.local → true（命中 .env.* glob）', () => {
    expect(isDangerousFile(join('project', '.env.local'))).toBe(true);
  });

  it('.env.production → true（命中 .env.* glob）', () => {
    expect(isDangerousFile(join('project', '.env.production'))).toBe(true);
  });

  it('.git/config → true（落在 DANGEROUS_DIRECTORIES）', () => {
    expect(isDangerousFile(join('project', '.git', 'config'))).toBe(true);
  });

  it('.bashrc → true（shell 配置）', () => {
    expect(isDangerousFile(join('home', '.bashrc'))).toBe(true);
  });

  it('.claude.json → true（agent 配置）', () => {
    expect(isDangerousFile(join('home', '.claude.json'))).toBe(true);
  });

  it('普通源码文件 → false', () => {
    expect(isDangerousFile(join('src', 'agent.ts'))).toBe(false);
  });

  it('普通配置 package.json → false', () => {
    expect(isDangerousFile(join('project', 'package.json'))).toBe(false);
  });
});

describe('isExternalDirectory', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = join(tmpdir(), `ecode-ext-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    rootB = join(tmpdir(), `ecode-ext-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(rootA)) rmSync(rootA, { recursive: true, force: true });
    if (existsSync(rootB)) rmSync(rootB, { recursive: true, force: true });
  });

  it('在任一 root 内 → false（非外部）', () => {
    expect(isExternalDirectory(join(rootA, 'x.txt'), [rootA, rootB])).toBe(false);
    expect(isExternalDirectory(join(rootB, 'y.txt'), [rootA, rootB])).toBe(false);
  });

  it('在所有 root 外 → true（外部）', () => {
    const outside = join(tmpdir(), `ecode-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(isExternalDirectory(join(outside, 'z.txt'), [rootA, rootB])).toBe(true);
  });
});

describe('checkPathSafety', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `ecode-safe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('工作区内普通文件 → 都安全', () => {
    const r = checkPathSafety(join(root, 'src', 'a.ts'), [root]);
    expect(r.external).toBe(false);
    expect(r.dangerousFile).toBe(false);
  });

  it('越界文件 → external=true', () => {
    const r = checkPathSafety(join(root, '..', 'escape.txt'), [root]);
    expect(r.external).toBe(true);
  });

  it('工作区内 .env → dangerousFile=true（即使未越界）', () => {
    const r = checkPathSafety(join(root, '.env'), [root]);
    expect(r.external).toBe(false);
    expect(r.dangerousFile).toBe(true);
  });

  it('无 path 的工具（空字符串/无意义）→ 不崩溃，返回非危险', () => {
    const r = checkPathSafety('', [root]);
    expect(r.dangerousFile).toBe(false);
  });
});
