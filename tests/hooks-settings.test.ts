// settings.json hooks 配置解析测试。
// 重点测 loadPermissionSettings 的 hooks 解析：合法/非法 event、matcher 默认值、source 标记。
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { loadPermissionSettings, type PermissionSettingsFile } from '../src/permission/settings-loader.js';

describe('loadPermissionSettings hooks 解析', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(os.tmpdir(), `ecode-test-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 静默 */ }
  });

  it('无 settings.json → hooks 为空数组', () => {
    // userDir 和 projectDir 都指向不存在的子目录 → 生成空模板 → hooks 为空
    const result = loadPermissionSettings({
      userDir: join(tempDir, 'u'),
      projectDir: join(tempDir, 'p'),
    });
    expect(result.hooks).toEqual([]);
  });

  it('解析 hooks 字段 → HookDef[]', () => {
    const settings: PermissionSettingsFile = {
      hooks: [
        { event: 'PreToolUse', command: 'echo "checking"', matcher: 'Bash' },
        { event: 'PostToolUse', command: 'echo "audit"' },
      ],
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({
      userDir: tempDir,
      projectDir: join(tempDir, 'p'), // 空 projectDir 避免读到真实配置
    });
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0].event).toBe('PreToolUse');
    expect(result.hooks[0].command).toBe('echo "checking"');
    expect(result.hooks[0].matcher).toBe('Bash');
    expect(result.hooks[0].source).toBe('user');
    expect(result.hooks[1].event).toBe('PostToolUse');
    expect(result.hooks[1].matcher).toBe('*'); // 默认
  });

  it('非法 event 静默跳过', () => {
    const settings: PermissionSettingsFile = {
      hooks: [
        { event: 'InvalidEvent', command: 'echo' },
        { event: 'PreToolUse', command: 'echo' },
      ],
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir: join(tempDir, 'p') });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0].event).toBe('PreToolUse');
  });

  it('缺 command → 跳过', () => {
    const settings: PermissionSettingsFile = {
      hooks: [
        { event: 'PreToolUse', command: 'valid' },
        { event: 'PostToolUse' }, // 缺 command
      ],
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir: join(tempDir, 'p') });
    expect(result.hooks).toHaveLength(1);
  });

  it('缺 event → 跳过', () => {
    const settings: PermissionSettingsFile = {
      hooks: [
        { command: 'echo' }, // 缺 event
      ],
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir: join(tempDir, 'p') });
    expect(result.hooks).toHaveLength(0);
  });

  it('hooks 非数组 → 空数组', () => {
    const settings = { hooks: 'invalid' };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir: join(tempDir, 'p') });
    expect(result.hooks).toHaveLength(0);
  });

  it('project 层 hooks → source=project', () => {
    const projectDir = join(tempDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    const settings: PermissionSettingsFile = {
      hooks: [{ event: 'PreToolUse', command: 'project-hook', matcher: 'Edit' }],
    };
    writeFileSync(join(projectDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({
      userDir: join(tempDir, 'u'), // user 层无 settings
      projectDir,
    });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0].source).toBe('project');
    expect(result.hooks[0].matcher).toBe('Edit');
  });

  it('rules 加载无回归（hooks 向后兼容）', () => {
    const settings: PermissionSettingsFile = {
      allow: ['Bash(ls)'],
      deny: ['Bash(rm *)'],
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    // projectDir 也预先写入空 settings.json，避免 writeSettingsTemplate 生成模板污染 rules
    const projectDir = join(tempDir, 'p');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'settings.json'), JSON.stringify({}), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir });
    expect(result.rules).toHaveLength(2); // allow + deny
    expect(result.hooks).toHaveLength(0); // 无 hooks
  });

  it('user + project 两层 hooks 合并（user 在前、project 在后）', () => {
    const userSettings: PermissionSettingsFile = {
      hooks: [{ event: 'PreToolUse', command: 'user-hook' }],
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(userSettings), 'utf-8');

    const projectDir = join(tempDir, 'proj');
    mkdirSync(projectDir, { recursive: true });
    const projectSettings: PermissionSettingsFile = {
      hooks: [{ event: 'PostToolUse', command: 'project-hook' }],
    };
    writeFileSync(join(projectDir, 'settings.json'), JSON.stringify(projectSettings), 'utf-8');

    const result = loadPermissionSettings({ userDir: tempDir, projectDir });
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0].source).toBe('user');
    expect(result.hooks[0].command).toBe('user-hook');
    expect(result.hooks[1].source).toBe('project');
    expect(result.hooks[1].command).toBe('project-hook');
  });

  it('hooks 为 null → 空数组', () => {
    const settings = { hooks: null };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir: join(tempDir, 'p') });
    expect(result.hooks).toHaveLength(0);
  });

  it('hooks 为空数组 → 空数组', () => {
    const settings: PermissionSettingsFile = { hooks: [] };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    const result = loadPermissionSettings({ userDir: tempDir, projectDir: join(tempDir, 'p') });
    expect(result.hooks).toHaveLength(0);
  });
});
