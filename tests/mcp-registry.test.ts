// 阶段3 MCP：registry（独立注册表）测试。
// 核心：① 独立于 config.json（VS Code 扩展模式，替换 config 不动 registry）
//      ② 走 resolveDataDir 跨平台 ③ 加载/保存往返 ④ 文件缺失/损坏 → 降级空数组不杀加载
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpRegistry, saveMcpRegistry, maskSecret } from '../src/mcp/registry.js';
import type { McpRegistryEntry } from '../src/mcp/registry.js';

const tmpDirs: string[] = [];
const freshDataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ecode-mcp-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // 清理失败忽略
    }
  }
});

const sampleEntry = (over: Partial<McpRegistryEntry> = {}): McpRegistryEntry => ({
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: 'ghp_xxx' },
  enabled: true,
  ...over,
});

describe('loadMcpRegistry（独立注册表加载）', () => {
  it('文件不存在 → 空数组（不报错，优雅降级）', () => {
    expect(loadMcpRegistry({ dataDir: freshDataDir() })).toEqual([]);
  });

  it('合法 registry.json → 返回 entries', () => {
    const dir = freshDataDir();
    saveMcpRegistry([sampleEntry()], { dataDir: dir });
    const loaded = loadMcpRegistry({ dataDir: dir });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('github');
    expect(loaded[0].transport).toBe('stdio');
    expect(loaded[0].enabled).toBe(true);
  });

  it('损坏 JSON → 空数组（降级不杀加载，对齐 config/settings-loader 风格）', () => {
    const dir = freshDataDir();
    mkdirSync(join(dir, 'mcp'), { recursive: true });
    writeFileSync(join(dir, 'mcp', 'registry.json'), '{ 不是合法 json');
    expect(loadMcpRegistry({ dataDir: dir })).toEqual([]);
  });

  it('registry.json 是数组外的结构 → 空数组（防御：只认数组）', () => {
    const dir = freshDataDir();
    mkdirSync(join(dir, 'mcp'), { recursive: true });
    writeFileSync(join(dir, 'mcp', 'registry.json'), JSON.stringify({ not: 'array' }));
    expect(loadMcpRegistry({ dataDir: dir })).toEqual([]);
  });
});

describe('saveMcpRegistry（写回 + enable/disable）', () => {
  it('保存后能读回（往返一致，含 env 凭证）', () => {
    const dir = freshDataDir();
    const entries = [sampleEntry(), sampleEntry({ name: 'fs', command: 'node' })];
    saveMcpRegistry(entries, { dataDir: dir });
    expect(loadMcpRegistry({ dataDir: dir })).toEqual(entries);
  });

  it('保存会自动创建 mcp/ 子目录', () => {
    const dir = freshDataDir();
    saveMcpRegistry([sampleEntry()], { dataDir: dir });
    expect(existsSync(join(dir, 'mcp', 'registry.json'))).toBe(true);
  });

  it('enable/disable 切换写回 registry（核心：/mcp enable|disable 语义）', () => {
    const dir = freshDataDir();
    saveMcpRegistry([sampleEntry({ enabled: true })], { dataDir: dir });
    const entries = loadMcpRegistry({ dataDir: dir });
    entries[0].enabled = false; // /mcp disable github
    saveMcpRegistry(entries, { dataDir: dir });
    expect(loadMcpRegistry({ dataDir: dir })[0].enabled).toBe(false);
  });

  it('description 字段往返一致（/mcp list/info 显示用）', () => {
    const dir = freshDataDir();
    saveMcpRegistry([sampleEntry({ description: 'GitHub 仓库操作' })], { dataDir: dir });
    const loaded = loadMcpRegistry({ dataDir: dir });
    expect(loaded[0].description).toBe('GitHub 仓库操作');
  });
});

describe('独立注册表（不进 config.json，VS Code 扩展模式）', () => {
  it('registry 落在 <dataDir>/mcp/registry.json（与 config.json 分离）', () => {
    const dir = freshDataDir();
    saveMcpRegistry([sampleEntry()], { dataDir: dir });
    // 物理位置确认
    const raw = JSON.parse(readFileSync(join(dir, 'mcp', 'registry.json'), 'utf-8'));
    expect(raw[0].name).toBe('github');
    // config.json 不存在也不影响 registry（独立注册）
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });

  it('enabled 过滤：loadMcpRegistry 返回全部（enabled 交由 loader 层筛选，registry 全量存）', () => {
    const dir = freshDataDir();
    saveMcpRegistry(
      [sampleEntry({ enabled: true }), sampleEntry({ name: 'disabled', enabled: false })],
      { dataDir: dir },
    );
    const loaded = loadMcpRegistry({ dataDir: dir });
    // registry 存全量（含 disabled），筛选职责在 loader（连哪些 server）
    expect(loaded).toHaveLength(2);
  });
});

describe('maskSecret（env 脱敏，/mcp info 用）', () => {
  it('短值（≤8）→ 全掩 ****', () => {
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('12345678')).toBe('****'); // 恰好 8 位 → 全掩
  });

  it('长值（>8）→ 首尾各 4 位 + ...', () => {
    expect(maskSecret('sk-abcdefghijklmnop')).toBe('sk-a...mnop');
  });

  it('空串 → ****（≤8 规则）', () => {
    expect(maskSecret('')).toBe('****');
  });
});
