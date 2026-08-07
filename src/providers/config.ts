import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ModelCapability, ModelConfig } from './types.js';

// ============================================================
// 配置系统：读 ~/.ecode/config.json，不存在用内置默认（开箱可用）
// ============================================================

export interface ProviderConfig {
  protocol: 'anthropic' | 'openai';
  baseURL?: string;
  apiKeyEnv: string; // 指向环境变量名，不在 config 里明文存 key（安全）
  /** baseURL 的环境变量名（厂商专属，与 apiKeyEnv 对称）：GLM_BASE_URL / DEEPSEEK_BASE_URL / ANTHROPIC_BASE_URL。
   *  优先级高于 baseURL：env 有值则覆盖 config.json 里的 baseURL（.env 灵活切换代理/端点）。 */
  baseURLEnv?: string;
  models?: string[];
}

export interface ECodeConfig {
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  /** P0-5 后置验证开关（edit/write 后跑 build/test，失败回喂）。默认 true；用户可设 false 关闭。 */
  validation?: { enabled?: boolean };
}

const CONFIG_PATH = join(homedir(), '.ecode', 'config.json');

/** 内置默认配置（无 config.json 时用，保证开箱可用） */
const DEFAULT_CONFIG: ECodeConfig = {
  defaultModel: 'glm-5.2',
  providers: {
    // GLM 走 coding plan 专用端点（含 /coding/）；普通 paas/v4 会因套餐不匹配报 429（对齐 CCode 源码 config-manager.ts:53）
    glm: { protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZHIPUAI_API_KEY', baseURLEnv: 'GLM_BASE_URL' },
    deepseek: { protocol: 'openai', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURLEnv: 'DEEPSEEK_BASE_URL' },
    claude: { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', baseURLEnv: 'ANTHROPIC_BASE_URL' },
  },
  models: {
    'glm-5.2': { provider: 'glm', capabilities: ['tools'], contextWindow: 1_000_000 },
    'deepseek-chat': { provider: 'deepseek', capabilities: ['tools'], contextWindow: 128_000 },
  },
};

let cachedConfig: ECodeConfig | null = null;

function loadConfig(): ECodeConfig {
  if (cachedConfig) return cachedConfig;
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      // 兼容首次生成的带 // 注释行（JSON 标准不含注释，手动 strip）
      const stripped = raw
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      cachedConfig = JSON.parse(stripped) as ECodeConfig;
      return cachedConfig;
    } catch (err) {
      console.error(
        `⚠️  解析 ${CONFIG_PATH} 失败，降级用默认配置: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // 首次启动：自动生成带注释的配置模板（生产级 UX：用户可见可改）
  writeConfigTemplate();
  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

/** 首次生成 ~/.ecode/config.json（含注释头，JSON 标准不支持注释，手动拼接）。 */
function writeConfigTemplate(): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  const header = [
    '// ECode 用户配置（首次启动自动生成）',
    '// 修改后重启 ECode 生效；也可通过 .env 环境变量覆盖（见 .env.example）。',
    '// API Key 通过环境变量注入（apiKeyEnv 字段），不要在此文件明文填写密钥。',
    '//',
    '// 添加自定义模型：',
    '//   1. 在 providers 中添加一个条目（protocol 选 "openai" 或 "anthropic"）',
    '//   2. 在 models 中添加一个条目（provider 指向上面的 key）',
    '//   3. 在 .env 中设置对应的 API Key 环境变量',
    '',
  ].join('\n');
  const json = JSON.stringify(DEFAULT_CONFIG, null, 2);
  try {
    writeFileSync(CONFIG_PATH, header + json + '\n', 'utf-8');
  } catch {
    // 首次生成失败不阻塞启动（目录权限等），静默降级用内存默认
  }
}

export function getDefaultModel(): string {
  const cfg = loadConfig();
  return cfg.defaultModel ?? Object.keys(cfg.models)[0] ?? '';
}

export function getModelConfig(model: string): ModelConfig {
  const cfg = loadConfig();
  const mc = cfg.models[model];
  if (!mc) {
    throw new Error(`未知模型: ${model}（可用: ${Object.keys(cfg.models).join(', ')}）`);
  }
  return mc;
}

export function getProviderConfig(providerKey: string): ProviderConfig {
  const cfg = loadConfig();
  const pc = cfg.providers[providerKey];
  if (!pc) throw new Error(`未知 provider: ${providerKey}`);
  return pc;
}

/**
 * 解析 provider 最终生效的 baseURL（三级优先级，借鉴 Claude Code env 覆盖 + CCode config 文件双入口）：
 *   ① process.env[baseURLEnv]  ← .env 灵活覆盖（GLM_BASE_URL 等，与 apiKeyEnv 对称），切代理/切端点不改 config.json
 *   ② providerConfig.baseURL   ← config.json 显式写（长期固定配置）
 *   ③ undefined                ← 都没有则不传，交 SDK 走协议默认地址（如 api.anthropic.com）
 * env 为空串视为未设置（.env 里留空=用默认），避免空 baseURL 破坏请求。
 */
export function resolveBaseURL(pc: ProviderConfig): string | undefined {
  const fromEnv = pc.baseURLEnv ? process.env[pc.baseURLEnv] : undefined;
  return fromEnv || pc.baseURL;
}

export function hasCapability(model: string, cap: ModelCapability): boolean {
  try {
    return getModelConfig(model).capabilities.includes(cap);
  } catch {
    return false;
  }
}

export function listAvailableModels(): Array<{ model: string; provider: string }> {
  return Object.entries(loadConfig().models).map(([model, mc]) => ({ model, provider: mc.provider }));
}

/** P0-5 后置验证是否启用（config.validation.enabled，默认 true）。validation.ts 集成层调用。 */
export function isValidationEnabled(): boolean {
  return loadConfig().validation?.enabled ?? true;
}

/** 获取模型上下文窗口大小（token），未配置时默认 128K */
export function getContextWindow(model: string): number {
  try {
    return getModelConfig(model).contextWindow ?? 128_000;
  } catch {
    return 128_000;
  }
}

/** 测试用：重置缓存（验证默认 vs 文件加载） */
export function _resetConfigCacheForTest(): void {
  cachedConfig = null;
}
