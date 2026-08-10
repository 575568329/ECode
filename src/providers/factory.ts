import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { getModelConfig, getProviderConfig, resolveApiKey, resolveBaseURL } from './config.js';
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

  // key 经两级解析（env > config.json.apiKey，见 resolveApiKey），与 baseURL 对称自给。
  const apiKey = resolveApiKey(providerConfig);
  if (!apiKey) {
    throw new Error(
      `模型 ${model} 缺少 API Key。请在 ~/.ecode/config.json 的 providers.${modelConfig.provider}.apiKey 填入（推荐，全局可用），或设置环境变量 ${providerConfig.apiKeyEnv}。`,
    );
  }

  // baseURL 经三级解析（env > config.json > 内置默认），见 resolveBaseURL
  const baseURL = resolveBaseURL(providerConfig);
  if (providerConfig.protocol === 'anthropic') {
    return new ClaudeProvider({ apiKey, baseURL });
  }
  return new OpenAIProvider({ apiKey, baseURL });
}
