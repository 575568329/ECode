import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
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
  /** 该 provider 下可用模型（key=模型名，value=capabilities/contextWindow/cost）。模型挂 provider 下（对齐 CCode/opencode），用户一目了然。 */
  models?: Record<string, ModelConfig>;
}

/** getModelConfig 的返回：模型配置 + 所属 provider key（由嵌套位置隐含，替代旧 ModelConfig.provider 字段）。 */
export interface ModelResolution {
  config: ModelConfig;
  providerKey: string;
}

export interface ECodeConfig {
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  // 顶层 models 已移除（2026-08-10 重构）：模型统一挂在 providers.<id>.models 下。旧格式由 migrateConfig 自动迁移。
  /** P0-5 后置验证开关（edit/write 后跑 build/test，失败回喂）。默认 true；用户可设 false 关闭。 */
  validation?: { enabled?: boolean };
  /** M6 模型路由块（router 层 buildRoutingConfig 解析为 RoutingConfig；此处宽松持有，避免 providers→router 分层耦合）。 */
  routing?: Record<string, unknown>;
  /** M6 技能捕获块（skill-capture 层 buildSkillCaptureConfig 解析；宽松持有，避免 providers→skill-capture 反向耦合）。 */
  skillCapture?: Record<string, unknown>;
  /** 上下文压缩配置（context-manager 消费）。不配则走内置默认值。 */
  compression?: {
    /** 压缩阈值比例（contextWindow × 此值，默认 0.8，留 20% 给本轮回复 + 工具结果） */
    thresholdRatio?: number;
    /** 压缩时保留最近 N 个往返组（默认 6） */
    keepRounds?: number;
    /** trim 时保留最近 N 个 tool_result 原文（默认 3，其余清空为占位符） */
    trimKeepRecent?: number;
  };
}

const CONFIG_PATH = join(resolveDataDir(), 'config.json');

/** 内置默认配置（无 config.json 时用，保证开箱可用） */
const DEFAULT_CONFIG: ECodeConfig = {
  defaultModel: 'glm-5.2',
  providers: {
    // GLM 走 coding plan 专用端点（含 /coding/）；普通 paas/v4 会因套餐不匹配报 429（对齐 CCode 源码 config-manager.ts:53）
    glm: {
      protocol: 'openai',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKeyEnv: 'ZHIPUAI_API_KEY',
      baseURLEnv: 'GLM_BASE_URL',
      models: {
        // GLM coding plan 为订阅制（bigmodel coding 套餐），不按 token 量计费；如需显示估算费用，
        // 用户可在 ~/.ecode/config.json 给 glm-5.2 补 cost 字段（$/M token）。
        'glm-5.2': { capabilities: ['tools'], contextWindow: 1_000_000 },
      },
    },
    deepseek: {
      protocol: 'openai',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURLEnv: 'DEEPSEEK_BASE_URL',
      models: {
        'deepseek-chat': {
          capabilities: ['tools'],
          contextWindow: 128_000,
          // deepseek 公开价（$/M token，2024-2025 档）：cacheRead 为命中缓存折扣价
          cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
        },
      },
    },
    claude: {
      protocol: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseURLEnv: 'ANTHROPIC_BASE_URL',
      // 无 models：该 provider 仅凭证配置（用户可在 models 下自行声明可用模型）
    },
  },
  // P0-5 后置验证：edit/write 成功后自动跑 build/test，失败回喂 LLM。
  // 默认 false（对齐 Aider auto-test：避免每次写文件阻塞验证拖慢体验）。
  // 想开启：把 enabled 改成 true（首次启动后此文件已生成在 ~/.ecode/config.json）。
  validation: { enabled: false },
  // M6 技能捕获（skill-capture §3）：UserPromptSubmit 时机记录用户修正/偏好到 .ecode/observations.jsonl，
  // /skill-gen 归纳生成提案 → /skill 审批。默认关闭（隐私 + 噪声）；开启后 patterns 与内置 correction/preference 合并命中即记。
  skillCapture: { enabled: false, patterns: [], maxBytes: 1_048_576, maxObservations: 1000 },
  // M6 模型路由（router 层 buildRoutingConfig 解析；不配 = 不路由，所有场景走主模型）。
  routing: { enabled: false },
  // 上下文压缩：控制 context window 快满时的自动压缩行为（context-manager 消费）。
  compression: { thresholdRatio: 0.8, keepRounds: 6, trimKeepRecent: 3 },
};

/** 首启生成的 config.json 注释头（writeConfigTemplate 与 migrateConfig 共用，保持一致）。 */
const CONFIG_HEADER_LINES = [
  '// ECode 用户配置（首次启动自动生成）',
  '// 修改后重启 ECode 生效；也可通过 .env 环境变量覆盖（见 .env.example）。',
  '// API Key：直接填 providers.<x>.apiKey（推荐，全局安装开箱可用）；或设 apiKeyEnv 对应的环境变量。',
  '//',
  '// 添加自定义 Provider：',
  '//   1. 在 providers 中添加一个条目（protocol 选 "openai" 或 "anthropic"）',
  '//   2. 在该 provider 的 models 中添加可用模型（key 为模型名，value 为 capabilities/contextWindow/cost）',
  '//   3. 在对应 provider 的 apiKey 字段填入密钥（或设 apiKeyEnv 对应的环境变量）',
  '//',
  '// 后置验证（validation.enabled）：edit/write 后自动跑 build/test，失败回喂 LLM。',
  '//   默认 false（对齐 Aider，避免每次写文件阻塞验证）。想开启：改成 true。',
  '//',
  '// 技能捕获（skillCapture，M6）：enabled=true 后自动记录用户修正/偏好，',
  '//   /skill-gen 归纳成提案、/skill 审批落盘。默认 false。详见 docs/详设 技能生成与模型路由。',
  '//',
  '// 模型路由（routing，M6，可选块）：把不同场景/难度的子任务路由到不同模型。不配 = 主模型一刀切。',
  '//   ① aliases（别名→模型落点，先定义）："aliases":{"cheap":{"provider":"deepseek","model":"deepseek-chat"},"strong":{"provider":"glm","model":"glm-5.2"}}',
  '//   ② rules（场景→别名；场景：subagent 子代理 / compress 压缩 / skill 技能）："rules":{"subagent":"cheap"}',
  '//   ③ complexityRouting（仅子代理生效）：true 时按任务难度动态选档——启发式评估',
  '//      （关键词+长度+改动范围+工具数）返回 simple/medium/complex，按 complexity 映射到别名。',
  '//      key 必须是 simple/medium/complex（写 low/high 不生效）：',
  '//      "complexityRouting":true,"complexity":{"simple":"cheap","medium":"strong","complex":"strong"}',
  '//   子代理选模优先级：人设 model > 复杂度档 > rules.subagent > 默认模型。',
  '//',
  '// 上下文压缩（compression）：对话快满 context window 时自动压缩旧消息。',
  '//   thresholdRatio: 触发压缩的阈值比例（默认 0.8，即占用 80% 时触发）',
  '//   keepRounds: 压缩时保留最近 N 轮对话（默认 6）',
  '//   trimKeepRecent: 清理旧工具输出时保留最近 N 个（默认 3）',
  '//',
  '// 模型名必须全局唯一（不允许在多个 provider 中定义同名模型）。',
  '',
];

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

// ---------------- 旧格式迁移（顶层 models → providers.*.models）----------------

/**
 * 检测并迁移旧版 config.json：顶层 models 搬入 providers.<provider>.models。
 * 触发条件：顶层 models 非空 且 所有 provider 下无嵌套 models（幂等：已迁移则跳过）。
 * 原子写回（tmp + rename，同文件系统），失败不阻塞启动（内存中新格式照常用）。
 */
function migrateConfig(raw: Record<string, unknown>): void {
  const oldModels = raw['models'] as Record<string, { provider?: string; [k: string]: unknown }> | undefined;
  if (!oldModels || typeof oldModels !== 'object') return;

  const providers = raw['providers'] as Record<string, Record<string, unknown>> | undefined;
  if (!providers) return;

  // 幂等：已有 provider 嵌套非空 models 则视为已迁移，跳过
  const alreadyMigrated = Object.values(providers).some((p) => {
    const m = p['models'] as Record<string, unknown> | undefined;
    return m && Object.keys(m).length > 0;
  });
  if (alreadyMigrated) return;

  console.error('🔄 检测到旧版 config.json 格式，正在自动迁移（models → providers.*.models）...');

  // 初始化每个 provider 的 models 容器
  for (const pc of Object.values(providers)) {
    if (!pc['models']) pc['models'] = {};
  }

  // 搬运模型：按旧 .provider 字段落到对应 provider（剔除该字段——provider 由嵌套位置隐含）
  for (const [modelId, mc] of Object.entries(oldModels)) {
    const { provider: providerKey, ...rest } = mc;
    if (!providerKey || typeof providerKey !== 'string') {
      console.error(`  ⚠ 跳过模型 "${modelId}"：缺少 provider 字段`);
      continue;
    }
    const targetProvider = providers[providerKey];
    if (!targetProvider) {
      console.error(`  ⚠ 跳过模型 "${modelId}"：provider "${providerKey}" 不存在`);
      continue;
    }
    (targetProvider['models'] as Record<string, unknown>)[modelId] = rest;
  }

  delete raw['models'];

  // 原子写回：先写临时文件，再 rename（同文件系统原子操作，避免中途崩溃损坏用户 config）
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    const header = CONFIG_HEADER_LINES.join('\n') + '\n';
    writeFileSync(tmpPath, header + JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, CONFIG_PATH);
    console.error('  ✅ 迁移完成，config.json 已更新。');
  } catch {
    try { unlinkSync(tmpPath); } catch { /* 临时文件清理失败忽略 */ }
    console.error('  ⚠ 迁移完成但写回文件失败，将使用内存中的新格式。');
  }
}

/**
 * 加载时校验：模型 ID 在所有 provider 中必须全局唯一。
 * 重复定义（多 provider 同名）抛错并拒绝启动——避免 getModelConfig 取到歧义模型。
 */
function validateModelUniqueness(cfg: ECodeConfig): void {
  const seen = new Map<string, string>(); // modelId → providerKey
  for (const [pk, pc] of Object.entries(cfg.providers)) {
    if (!pc.models) continue;
    for (const modelId of Object.keys(pc.models)) {
      const prev = seen.get(modelId);
      if (prev) {
        throw new Error(
          `模型 "${modelId}" 在 provider "${prev}" 和 "${pk}" 中重复定义。模型 ID 必须全局唯一。`,
        );
      }
      seen.set(modelId, pk);
    }
  }
}

/**
 * 在已加载的 cfg 中查找模型（纯查找，**不触发 loadConfig**）。
 * 规避 loadConfig 内 defaultModel 校验的递归：校验需查模型，若调 getModelConfig 会再入 loadConfig。
 * 遍历 providers，返回首个命中模型的 {config, providerKey}。
 */
function findModel(cfg: ECodeConfig, modelId: string): ModelResolution | undefined {
  const lower = modelId.toLowerCase();
  for (const [pk, pc] of Object.entries(cfg.providers)) {
    if (!pc.models) continue;
    // 精确匹配优先（区分大小写）：同时存在大小写近似 key 时精确的赢，无歧义。
    const exact = pc.models[modelId];
    if (exact) return { config: exact, providerKey: pk };
    // 降级：大小写不敏感匹配。用户 config.json 常按厂商惯例写大写（如 GLM-5.2），
    // 而代码/测试各处多用小写（glm-5.2）；模型名作标识符，大小写差异不应致静默查不到——
    // 否则 getContextWindow 兜底 128K，上下文压缩阈值算错。见 debugging #017。
    for (const [k, v] of Object.entries(pc.models)) {
      if (k.toLowerCase() === lower) return { config: v, providerKey: pk };
    }
  }
  return undefined;
}

/** 取首个非空 provider.models 的模型 key（defaultModel 缺失时兜底）。 */
function firstModelKey(cfg: ECodeConfig): string {
  for (const pc of Object.values(cfg.providers)) {
    if (pc.models && Object.keys(pc.models).length > 0) return Object.keys(pc.models)[0]!;
  }
  return '';
}

export function loadConfig(): ECodeConfig {
  if (cachedConfig) return cachedConfig;
  if (existsSync(CONFIG_PATH)) {
    let parsed: Record<string, unknown>;
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      // JSONC：剥离行注释与块注释（字符串内不误剥），支持用户在 config.json 写注释（§7）。
      parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
      migrateConfig(parsed);
    } catch (err) {
      // 解析/迁移失败：软降级到默认配置（文件损坏不应砖住启动）
      console.error(
        `⚠️  解析 ${CONFIG_PATH} 失败，降级用默认配置: ${err instanceof Error ? err.message : err}`,
      );
      writeConfigTemplate();
      cachedConfig = DEFAULT_CONFIG;
      return cachedConfig;
    }
    cachedConfig = parsed as unknown as ECodeConfig;
    // 模型全局唯一校验：重复定义属严重配置错误，上抛拒绝启动（不降级——降级会掩盖问题）。
    validateModelUniqueness(cachedConfig);
    // defaultModel 校验：指向不存在的模型时软降级（stderr 警告 + 置空，getDefaultModel 兜底首个可用）。
    if (cachedConfig.defaultModel && !findModel(cachedConfig, cachedConfig.defaultModel)) {
      console.error(`⚠️  defaultModel "${cachedConfig.defaultModel}" 未在任何 provider 中找到，将回退首个可用模型`);
      cachedConfig.defaultModel = undefined;
    }
    return cachedConfig;
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
  const header = CONFIG_HEADER_LINES.join('\n') + '\n';
  const json = JSON.stringify(DEFAULT_CONFIG, null, 2);
  try {
    writeFileSync(CONFIG_PATH, header + json + '\n', 'utf-8');
  } catch {
    // 首次生成失败不阻塞启动（目录权限等），静默降级用内存默认
  }
}

export function getDefaultModel(): string {
  const cfg = loadConfig();
  return cfg.defaultModel ?? firstModelKey(cfg);
}

export function getModelConfig(model: string): ModelResolution {
  const cfg = loadConfig();
  const found = findModel(cfg, model);
  if (!found) {
    throw new Error(`未知模型: ${model}（可用: ${listAvailableModels().map((m) => m.model).join(', ')}）`);
  }
  return found;
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
    return getModelConfig(model).config.capabilities.includes(cap);
  } catch {
    return false;
  }
}

export function listAvailableModels(): Array<{ model: string; provider: string }> {
  const result: Array<{ model: string; provider: string }> = [];
  for (const [pk, pc] of Object.entries(loadConfig().providers)) {
    if (pc.models) {
      for (const model of Object.keys(pc.models)) {
        result.push({ model, provider: pk });
      }
    }
  }
  return result;
}

/** P0-5 后置验证是否启用（config.validation.enabled，默认 false，对齐 Aider）。validation.ts 集成层调用。 */
export function isValidationEnabled(): boolean {
  return loadConfig().validation?.enabled ?? false;
}

/** 获取模型上下文窗口大小（token），未配置时默认 128K */
export function getContextWindow(model: string): number {
  try {
    return getModelConfig(model).config.contextWindow ?? 128_000;
  } catch {
    return 128_000;
  }
}

// ----------- 上下文压缩配置（context-manager 消费）-----------

/** 压缩阈值比例（contextWindow × 此值，默认 0.8） */
export function getCompressThresholdRatio(): number {
  return loadConfig().compression?.thresholdRatio ?? 0.8;
}

/** 压缩时保留最近 N 个往返组（默认 6） */
export function getCompressKeepRounds(): number {
  return loadConfig().compression?.keepRounds ?? 6;
}

/** trim 时保留最近 N 个 tool_result 原文（默认 3） */
export function getTrimKeepRecent(): number {
  return loadConfig().compression?.trimKeepRecent ?? 3;
}

/** 测试用：重置缓存（验证默认 vs 文件加载） */
export function _resetConfigCacheForTest(): void {
  cachedConfig = null;
}
