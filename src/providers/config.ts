import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelCapability, ModelConfig } from './types.js';

// ============================================================
// 配置系统：读 ~/.ecode/config.json，不存在用内置默认（开箱可用）
// ============================================================

export interface ProviderConfig {
  protocol: 'anthropic' | 'openai';
  baseURL?: string;
  apiKeyEnv: string; // 指向环境变量名，不在 config 里明文存 key（安全）
  models?: string[];
}

export interface ECodeConfig {
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
}

const CONFIG_PATH = join(homedir(), '.ecode', 'config.json');

/** 内置默认配置（无 config.json 时用，保证开箱可用） */
const DEFAULT_CONFIG: ECodeConfig = {
  defaultModel: 'glm-5.2',
  providers: {
    glm: { protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPUAI_API_KEY' },
    deepseek: { protocol: 'openai', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    claude: { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  },
  models: {
    'glm-5.2': { provider: 'glm', capabilities: ['tools'] },
    'deepseek-chat': { provider: 'deepseek', capabilities: ['tools'] },
  },
};

let cachedConfig: ECodeConfig | null = null;

function loadConfig(): ECodeConfig {
  if (cachedConfig) return cachedConfig;
  if (existsSync(CONFIG_PATH)) {
    try {
      cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ECodeConfig;
      return cachedConfig;
    } catch (err) {
      console.error(
        `⚠️  解析 ${CONFIG_PATH} 失败，降级用默认配置: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
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

/** 测试用：重置缓存（验证默认 vs 文件加载） */
export function _resetConfigCacheForTest(): void {
  cachedConfig = null;
}
