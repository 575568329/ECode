// MCP（支点 10）独立注册表 —— server 配置不进 config.json，单列 registry.json（VS Code 扩展模式）。
//
// 设计（决策 #003 / 技术选型 10-T）：
//   - 独立注册表：替换/删除 config.json 不影响 MCP server 配置（防「config 连坐删」）。
//   - 走 resolveDataDir()（§9.3 跨平台单一入口，不散用 homedir()/'~'）。
//   - 显式登记才连（loader 遍历 enabled，不自动跑）—— /mcp enable|disable 写回本表。
//   - 加载失败（文件缺失/损坏/非数组）→ 空数组降级，不砖住 agent（对齐 config/settings-loader 风格）。
//
// 注：本模块只管「存/取配置」，不含 SDK 依赖、不 spawn server、不做 RCE 校验——
//   连接（client.ts）+ stdio RCE allowlist（安全红线 10-T7）在阶段 3 后续，独立审阅。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../paths.js';

const MCP_SUBDIR = 'mcp';
const REGISTRY_FILE = 'registry.json';

/** registry 单条：一个 MCP server 的连接配置。 */
export interface McpRegistryEntry {
  /** server 名（工具命名空间前缀：mcp__<name>__<tool>）。 */
  name: string;
  /** 传输：阶段 1 只 stdio；http（Streamable HTTP）阶段 4 远期框架。 */
  transport: 'stdio' | 'http';
  /** stdio：启动命令（如 'npx'）。spawn 前须经 RCE allowlist 校验（client.ts，10-T7）。 */
  command?: string;
  /** stdio：参数（如 ['-y', '@modelcontextprotocol/server-github']）。 */
  args?: string[];
  /** 环境变量（凭证，不进 config.json，仅存 registry）。 */
  env?: Record<string, string>;
  enabled: boolean;
  // 阶段 4 远期：url?: string; oauth?: {...}
}

/** registry.json 物理路径（<dataDir>/mcp/registry.json）。 */
function registryPath(dataDir: string): string {
  return join(dataDir, MCP_SUBDIR, REGISTRY_FILE);
}

/**
 * 加载 MCP 注册表。文件缺失/损坏/非数组 → 空数组（降级不杀加载）。
 * @param opts.dataDir 显式数据目录（测试用）；默认 resolveDataDir()。
 */
export function loadMcpRegistry(opts?: { dataDir?: string }): McpRegistryEntry[] {
  const file = registryPath(opts?.dataDir ?? resolveDataDir());
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    // 防御：只认数组结构（顶层对象等异形 → 降级空）
    if (!Array.isArray(parsed)) return [];
    return parsed as McpRegistryEntry[];
  } catch {
    return []; // 损坏 JSON 静默降级
  }
}

/**
 * 写回 MCP 注册表（/mcp enable|disable 用）。自动创建 mcp/ 子目录。
 * @param opts.dataDir 显式数据目录（测试用）；默认 resolveDataDir()。
 */
export function saveMcpRegistry(
  entries: McpRegistryEntry[],
  opts?: { dataDir?: string },
): void {
  const file = registryPath(opts?.dataDir ?? resolveDataDir());
  mkdirSync(join(opts?.dataDir ?? resolveDataDir(), MCP_SUBDIR), { recursive: true });
  writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
}
