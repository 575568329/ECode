import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveDataDir } from '../paths.js';
import type { ModelCapability, ModelConfig } from './types.js';

// ============================================================
// 配置系统：读 ~/.ecode/config.json，不存在用内置默认（开箱可用）
// ============================================================

export interface ProviderConfig {
  protocol: 'anthropic' | 'openai';
  baseURL?: string;
  /** API Key 明文值（推荐：全局安装开箱可用，与 baseURL 对称自给）。
   *  resolveApiKey 两级解析：env（apiKeyEnv）> 此字段。两者皆空 → factory 抛错。
   *  安全级别与 baseURL 相同（本地 ~/.ecode/ 已 gitignore，不进 git/日志/前端）。 */
  apiKey?: string;
  /** API Key 的环境变量名（开发 .env / CI 临时覆盖用）。env 有值则覆盖 apiKey 字段。 */
  apiKeyEnv: string;
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
  /** M6 模型路由块（router 层 buildRoutingConfig 解析为 RoutingConfig；此处宽松持有，避免 providers→router 分层耦合）。 */
  routing?: Record<string, unknown>;
  /** M6 技能捕获块（skill-capture 层 buildSkillCaptureConfig 解析；宽松持有，避免 providers→skill-capture 反向耦合）。 */
  skillCapture?: Record<string, unknown>;
}

const CONFIG_PATH = join(resolveDataDir(), 'config.json');

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
    // GLM coding plan 为订阅制（bigmodel coding 套餐），不按 token 量计费；如需显示估算费用，
    // 用户可在 ~/.ecode/config.json 给 glm-5.2 补 cost 字段（$/M token）。
    'glm-5.2': { provider: 'glm', capabilities: ['tools'], contextWindow: 1_000_000 },
    'deepseek-chat': {
      provider: 'deepseek',
      capabilities: ['tools'],
      contextWindow: 128_000,
      // deepseek 公开价（$/M token，2024-2025 档）：cacheRead 为命中缓存折扣价
      cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
    },
  },
  // P0-5 后置验证：edit/write 成功后自动跑 build/test，失败回喂 LLM。
  // 默认 false（对齐 Aider auto-test：避免每次写文件阻塞验证拖慢体验）。
  // 想开启：把 enabled 改成 true（首次启动后此文件已生成在 ~/.ecode/config.json）。
  validation: { enabled: false },
  // M6 技能捕获（skill-capture §3）：UserPromptSubmit 时机记录用户修正/偏好到 .ecode/observations.jsonl，
  // /skill-gen 归纳生成提案 → /skill 审批。默认关闭（隐私 + 噪声）；开启后 patterns 与内置 correction/preference 合并命中即记。
  skillCapture: { enabled: false, patterns: [], maxBytes: 1_048_576, maxObservations: 1000 },
};

let cachedConfig: ECodeConfig | null = null;

/**
 * 剥离 JSONC 注释（行注释 + 块注释），零依赖状态机。
 * 关键：字符串字面量内的注释符号不被剥（如 URL https://、正则模式），正确处理转义引号；
 *      换行符保留（行号对齐，解析错误时信息可读）。
 * 标准 JSON 是合法 JSONC，故无注释时原样可解析（config.json 零迁移，§7）。
 */
export function stripJsonComments(raw: string): string {
  let out = '';
  let i = 0;
  const len = raw.length;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      // 行注释：跳过本行剩余，遇到换行回 normal 并保留换行（行号对齐）
      if (ch === '\n') { inLineComment = false; out += ch; }
      i++;
      continue;
    }
    if (inBlockComment) {
      // 块注释：跳过直到结束符；跨行时保留换行（行号对齐）
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      if (ch === '\n') out += ch;
      i++;
      continue;
    }
    if (inString) {
      // 字符串内：转义符原样输出下一字符（防 \" 被当作字符串结束）；遇 " 结束字符串
      if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
      if (ch === '"') inString = false;
      out += ch;
      i++;
      continue;
    }
    // normal：识别字符串起点与两种注释起点
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

export function loadConfig(): ECodeConfig {
  if (cachedConfig) return cachedConfig;
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      // JSONC：剥离行注释与块注释（字符串内不误剥），支持用户在 config.json 写注释（§7）。
      cachedConfig = JSON.parse(stripJsonComments(raw)) as ECodeConfig;
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
    '// API Key：直接填 providers.<x>.apiKey（推荐，全局安装开箱可用）；或设 apiKeyEnv 对应的环境变量。',
    '//',
    '// 添加自定义模型：',
    '//   1. 在 providers 中添加一个条目（protocol 选 "openai" 或 "anthropic"）',
    '//   2. 在 models 中添加一个条目（provider 指向上面的 key）',
    '//   3. 在对应 provider 的 apiKey 字段填入密钥（或设 apiKeyEnv 对应的环境变量）',
    '//',
    '// 后置验证（validation.enabled）：edit/write 后自动跑 build/test，失败回喂 LLM。',
    '//   默认 false（对齐 Aider，避免每次写文件阻塞验证）。想开启：改成 true。',
    '//',
    '// 技能捕获（skillCapture，M6）：enabled=true 后自动记录用户修正/偏好，',
    '//   /skill-gen 归纳成提案、/skill 审批落盘。默认 false。详见 docs/详设 技能生成与模型路由。',
    '//',
    '// 模型路由（routing，M6，可选块）：按场景/复杂度把子任务路由到不同模型。',
    '//   不配 = 主模型一刀切（compress/skill/subagent 都走当前模型）。',
    '//   示例：{"rules":{"subagent":"deepseek-chat"},"complexityRouting":true,"complexity":{"low":"deepseek-chat","high":"glm-5.2"}}',
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

/**
 * 解析 provider 最终生效的 apiKey（两级优先级，对称 resolveBaseURL）：
 *   ① process.env[apiKeyEnv]  ← .env / CI 临时覆盖（开发期切 key 不改 config.json）
 *   ② providerConfig.apiKey    ← config.json 明文存值（全局安装无 .env 注入时自给，与 baseURL 对称）
 *   ③ undefined                ← 都没有则 factory 层抛错
 * env 为空串视为未设置（对齐 resolveBaseURL），避免空 key 破坏请求。
 *
 * 设计动机（修「读 config.json 却报错指向 .env」的矛盾）：baseURL 早就能从 config.json
 * 自给（resolveBaseURL 三级解析），key 却只存 apiKeyEnv 名字、取值靠 process.env——全局安装
 * （node dist/index.js）无 tsx --env-file 注入，process.env 里没 key → 静默报「未设置」并误导
 * 用户改 .env。key 与 baseURL 同为连接凭证，应同等自给，故补 apiKey 字段 + env 覆盖
 * （呼应 §1.1 配置自洽、零外部依赖；安全级别同 baseURL，本地文件不入 git/日志/前端）。
 */
export function resolveApiKey(pc: ProviderConfig): string | undefined {
  const fromEnv = pc.apiKeyEnv ? process.env[pc.apiKeyEnv] : undefined;
  return fromEnv || pc.apiKey;
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

/** P0-5 后置验证是否启用（config.validation.enabled，默认 false，对齐 Aider）。validation.ts 集成层调用。 */
export function isValidationEnabled(): boolean {
  return loadConfig().validation?.enabled ?? false;
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
