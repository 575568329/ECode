import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { getModelConfig, getProviderConfig, resolveBaseURL } from './config.js';
import type { ModelProvider } from './types.js';

/**
 * 按 model 名创建对应 Provider。
 * 流程：model → ModelConfig（查 provider）→ ProviderConfig（查 protocol/baseURL/apiKeyEnv）
 *      → 读环境变量拿 key → 按 protocol 选 ClaudeProvider / OpenAIProvider。
 * 加新模型只改 config.json，这里零改动（交付②）。
 */
export function createProvider(model: string): ModelProvider {
  const modelConfig = getModelConfig(model);
  const providerConfig = getProviderConfig(modelConfig.provider);

  const apiKey = process.env[providerConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `模型 ${model} 需要环境变量 ${providerConfig.apiKeyEnv}，但未设置（请在 .env 里配置）`,
    );
  }

  // baseURL 经三级解析（env > config.json > 内置默认），见 resolveBaseURL
  const baseURL = resolveBaseURL(providerConfig);
  if (providerConfig.protocol === 'anthropic') {
    return new ClaudeProvider({ apiKey, baseURL });
  }
  return new OpenAIProvider({ apiKey, baseURL });
}
