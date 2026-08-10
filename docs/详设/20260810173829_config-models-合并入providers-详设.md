# 重构 config.json：models 合入 providers

> 状态：审阅通过（含 3 🔴 修复）
> 日期：2026-08-10
> 背景：参考 CCode/opencode 设计，解决用户配了 provider 却不知道能填什么模型名的问题
> 审阅记录：角色 agent 架构评审，发现 3 个阻塞项已补齐

---

## Context

当前 ECode 的 `config.json` 把 `models` 放在顶层、与 `providers` 分离：

```jsonc
// 当前结构（不合理）
{
  "defaultModel": "glm-5.2",
  "providers": {
    "glm": { "protocol": "openai", "baseURL": "..." }
  },
  "models": {
    "glm-5.2": { "provider": "glm", "capabilities": ["tools"], "contextWindow": 1000000 }
  }
}
```

**问题**：用户配了 `deepseek` provider，但不知道该填什么模型名（`deepseek-chat`？`deepseek-coder`？`deepseek-reasoner`？）。CCode 和 opencode 都是模型挂在 provider 下面，用户一目了然。

---

## 目标结构

参考 opencode 的 `provider.<id>.models.<model_id>` 映射（因为 ECode 的 ModelConfig 有 per-model 属性如 capabilities/contextWindow/cost）：

```jsonc
// 目标结构
{
  "defaultModel": "glm-5.2",
  "providers": {
    "glm": {
      "protocol": "openai",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "apiKey": "...",
      "apiKeyEnv": "ZHIPUAI_API_KEY",
      "baseURLEnv": "GLM_BASE_URL",
      "models": {
        "glm-5.2": { "capabilities": ["tools"], "contextWindow": 1000000 }
      }
    },
    "deepseek": {
      "protocol": "openai",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "...",
      "models": {
        "deepseek-chat": { "capabilities": ["tools"], "contextWindow": 128000, "cost": {...} },
        "deepseek-reasoner": { "capabilities": ["tools", "thinking"], "contextWindow": 128000 }
      }
    },
    "claude": {
      "protocol": "anthropic",
      "baseURL": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "baseURLEnv": "ANTHROPIC_BASE_URL"
      // models 为空 — 该 provider 仅有凭证，无可用模型声明
    }
  }
}
```

---

## 改动清单

### Phase 1: 类型

**`src/providers/types.ts`** — ModelConfig 删 `provider` 字段

```typescript
// 删除 provider: string; （已由父级 ProviderConfig key 隐含）
export interface ModelConfig {
  capabilities: ModelCapability[];
  contextWindow?: number;
  cost?: ModelCost;
}
```

**`src/providers/config.ts`** — ProviderConfig 替换旧 models 字段、ECodeConfig 删顶层 models

> 🔴 修复：当前 `ProviderConfig` 已有 `models?: string[]`（config.ts:22），方案要替换为 `models?: Record<string, ModelConfig>`。经搜索确认旧字段无消费方，直接替换即可。

```typescript
export interface ProviderConfig {
  protocol: 'anthropic' | 'openai';
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv: string;
  baseURLEnv?: string;
  // 旧: models?: string[];   ← 删除（无消费方）
  models?: Record<string, ModelConfig>;  // 新增
}

export interface ECodeConfig {
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  // models: Record<string, ModelConfig>;  ← 删除顶层 models
  validation?: { enabled?: boolean };
  routing?: Record<string, unknown>;
  skillCapture?: Record<string, unknown>;
  compression?: { thresholdRatio?: number; keepRounds?: number; trimKeepRecent?: number };
}
```

新增内部类型（config.ts 内部）：

```typescript
export interface ModelResolution {
  config: ModelConfig;
  providerKey: string;
}
```

### Phase 2: 核心函数（config.ts）

**`DEFAULT_CONFIG`** — models 嵌入各 provider，claude 的 models 为空

```typescript
const DEFAULT_CONFIG: ECodeConfig = {
  defaultModel: 'glm-5.2',
  providers: {
    glm: {
      protocol: 'openai',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKeyEnv: 'ZHIPUAI_API_KEY',
      baseURLEnv: 'GLM_BASE_URL',
      models: {
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
          cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
        },
      },
    },
    claude: {
      protocol: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseURLEnv: 'ANTHROPIC_BASE_URL',
      // 无 models — 仅有凭证配置
    },
  },
  validation: { enabled: false },
  skillCapture: { enabled: false, patterns: [], maxBytes: 1_048_576, maxObservations: 1000 },
  routing: { enabled: false },
  compression: { thresholdRatio: 0.8, keepRounds: 6, trimKeepRecent: 3 },
};
```

**新增 `migrateConfig(raw)`** — 旧格式自动迁移

> 🔴 修复：写回磁盘改用原子写入（写临时文件 + rename），避免中途崩溃损坏用户 config。

```typescript
import { renameSync } from 'node:fs';

function migrateConfig(raw: Record<string, unknown>): void {
  const oldModels = raw['models'] as Record<string, { provider?: string; [k: string]: unknown }> | undefined;
  if (!oldModels || typeof oldModels !== 'object') return;

  const providers = raw['providers'] as Record<string, Record<string, unknown>> | undefined;
  if (!providers) return;

  // 幂等：已有 provider 嵌套 models 则跳过
  if (Object.values(providers).some(p => {
    const m = p['models'] as Record<string, unknown> | undefined;
    return m && Object.keys(m).length > 0;
  })) return;

  console.error('🔄 检测到旧版 config.json 格式，正在自动迁移（models → providers.*.models）...');

  // 初始化每个 provider 的 models
  for (const pc of Object.values(providers)) {
    if (!pc['models']) pc['models'] = {};
  }

  // 搬运模型
  for (const [modelId, mc] of Object.entries(oldModels)) {
    const { provider: providerKey, ...rest } = mc;
    if (!providerKey || typeof providerKey !== 'string') {
      console.error(`  ⚠ 跳过模型 "${modelId}"：缺少 provider 字段`);
      continue;
    }
    if (!providers[providerKey]) {
      console.error(`  ⚠ 跳过模型 "${modelId}"：provider "${providerKey}" 不存在`);
      continue;
    }
    (providers[providerKey]['models'] as Record<string, unknown>)[modelId] = rest;
  }

  delete raw['models'];

  // 原子写入：先写临时文件，再 rename
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    const header = [...SETTINGS_HEADER_LINES, ...].join('\n') + '\n';
    writeFileSync(tmpPath, header + JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, CONFIG_PATH);  // 原子操作（同文件系统）
    console.error('  ✅ 迁移完成，config.json 已更新。');
  } catch {
    // 清理临时文件
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error('  ⚠ 迁移完成但写回文件失败，将使用内存中的新格式。');
  }
}
```

**`loadConfig()`** — parse 后调 `migrateConfig(parsed)` 再缓存

> 🟡 补充：迁移后加 defaultModel 校验——指向不存在的模型时报友好错误。

```typescript
export function loadConfig(): ECodeConfig {
  if (cachedConfig) return cachedConfig;
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
      migrateConfig(parsed);
      cachedConfig = parsed as ECodeConfig;
      // defaultModel 校验
      if (cachedConfig.defaultModel) {
        try { getModelConfigInternal(cachedConfig, cachedConfig.defaultModel); }
        catch {
          console.error(`⚠️  defaultModel "${cachedConfig.defaultModel}" 未在任何 provider 中找到，将回退首个可用模型`);
          cachedConfig.defaultModel = undefined;
        }
      }
      return cachedConfig;
    } catch (err) {
      console.error(`⚠️  解析 ${CONFIG_PATH} 失败，降级用默认配置: ${err instanceof Error ? err.message : err}`);
    }
  }
  writeConfigTemplate();
  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}
```

> 注意：`getModelConfigInternal` 是一个不触发 loadConfig 的纯查找函数（避免 loadConfig 递归），或直接内联查找逻辑。

**`getDefaultModel()`** — 兜底改为遍历 providers 取首个模型

```typescript
function firstModelKey(cfg: ECodeConfig): string {
  for (const pc of Object.values(cfg.providers)) {
    if (pc.models && Object.keys(pc.models).length > 0) return Object.keys(pc.models)[0];
  }
  return '';
}

export function getDefaultModel(): string {
  const cfg = loadConfig();
  return cfg.defaultModel ?? firstModelKey(cfg);
}
```

**`getModelConfig(model)`** — 返回 `ModelResolution`（含 providerKey）

> 🔴 修复：多 provider 同名模型冲突——加载时校验全局唯一，重复时报错。

```typescript
/** 加载时校验：模型 ID 在所有 provider 中必须全局唯一 */
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

export function getModelConfig(model: string): ModelResolution {
  const cfg = loadConfig();
  for (const [pk, pc] of Object.entries(cfg.providers)) {
    const mc = pc.models?.[model];
    if (mc) return { config: mc, providerKey: pk };
  }
  throw new Error(`未知模型: ${model}（可用: ${listAvailableModels().map(m => m.model).join(', ')}）`);
}
```

`validateModelUniqueness` 在 `loadConfig()` 缓存前调用。

**`listAvailableModels()`** — 从嵌套结构展平（返回值类型不变）

```typescript
export function listAvailableModels(): Array<{ model: string; provider: string }> {
  const result: Array<{ model: string; provider: string }> = [];
  for (const [pk, pc] of Object.entries(loadConfig().providers)) {
    if (pc.models) {
      for (const m of Object.keys(pc.models)) {
        result.push({ model: m, provider: pk });
      }
    }
  }
  return result;
}
```

**`hasCapability()`** — `getModelConfig(model).config.capabilities`

**`getContextWindow()`** — `getModelConfig(model).config.contextWindow`

**`writeConfigTemplate()`** — 更新注释头

```typescript
const header = [
  '// ECode 用户配置（首次启动自动生成）',
  '// 修改后重启 ECode 生效；也可通过 .env 环境变量覆盖（见 .env.example）。',
  '// API Key：直接填 providers.<x>.apiKey（推荐，全局安装开箱可用）；或设 apiKeyEnv 对应的环境变量。',
  '//',
  '// 添加自定义 Provider：',
  '//   1. 在 providers 中添加一个条目（protocol 选 "openai" 或 "anthropic"）',
  '//   2. 在该 provider 的 models 中添加可用模型（key 为模型名，value 为 capabilities/contextWindow/cost）',
  '//   3. 在对应 provider 的 apiKey 字段填入密钥（或设 apiKeyEnv 对应的环境变量）',
  '//',
  '// ... 其余注释不变 ...',
  '//',
  '// 模型名必须全局唯一（不允许在多个 provider 中定义同名模型）。',
];
```

### Phase 3: 直接消费方

**`src/providers/factory.ts`**

```typescript
// 旧：const modelConfig = getModelConfig(model); const pc = getProviderConfig(modelConfig.provider);
// 新：
const { config: modelConfig, providerKey } = getModelConfig(model);
const providerConfig = getProviderConfig(providerKey);
```

**`src/router/config.ts`** — `buildRoutingConfig()` 解析 defaultTarget

```typescript
// 完整改后代码
export function buildRoutingConfig(cfg: ECodeConfig): RoutingConfig {
  const routing = (cfg.routing as RoutingRaw | undefined) ?? {};
  const aliases = routing.aliases ?? {};
  const rules = routing.rules ?? {};

  const defaultModel = cfg.defaultModel ?? (() => {
    for (const pc of Object.values(cfg.providers)) {
      if (pc.models && Object.keys(pc.models).length > 0) return Object.keys(pc.models)[0];
    }
    return '';
  })();

  // 从嵌套结构中找 defaultModel 所属的 provider
  let providerKey: string | undefined;
  for (const [pk, pc] of Object.entries(cfg.providers)) {
    if (pc.models?.[defaultModel]) { providerKey = pk; break; }
  }
  const defaultTarget: AliasTarget = providerKey
    ? { provider: providerKey, model: defaultModel }
    : { provider: '', model: defaultModel };

  return {
    aliases,
    rules,
    defaultTarget,
    complexityRouting: routing.complexityRouting ?? false,
    complexity: routing.complexity,
  };
}
```

### Phase 4: UI 层

**`src/ui/app.tsx`**
- `getModelConfig(currentModel).cost` → `getModelConfig(currentModel).config.cost`
- StatusBar `provider` 修复 bug（当前传的是 model 名而非 provider 名）：从 `getModelConfig` 取 `providerKey`

```tsx
// 修复前：
<StatusBar provider={currentModel ?? 'default'} ... />
// 修复后：
let currentProvider = 'default';
try { currentProvider = getModelConfig(currentModel).providerKey; } catch { /* 保持 default */ }
<StatusBar provider={currentProvider} ... />
```

### Phase 5: 测试更新

> 🟡 补充：迁移逻辑至少需覆盖 4 个测试用例（旧格式检测、迁移正确性、幂等性、provider 不存在时的行为）。

**`tests/providers/config.test.ts`**

```typescript
// 旧 fixture：
const config = { providers: { glm: { ... } }, models: { 'glm-5.2': { provider: 'glm', capabilities: ['tools'] } } };
// 新 fixture：
const config = { providers: { glm: { ..., models: { 'glm-5.2': { capabilities: ['tools'] } } } } };

// getModelConfig 断言：
// 旧：expect(getModelConfig('glm-5.2')).toEqual({ provider: 'glm', capabilities: ['tools'] });
// 新：expect(getModelConfig('glm-5.2')).toEqual({ config: { capabilities: ['tools'] }, providerKey: 'glm' });
```

所有 5 处 `models:` fixture 需逐一迁移（L89、L109、L123、L149 等）。

**`tests/providers/factory.test.ts`**

```typescript
// L57 旧：
// models: { 'glm-5.2': { provider: 'glm', capabilities: ['tools'] } }
// L57 新：models 嵌入 providers.glm 内
providers: { glm: { ..., models: { 'glm-5.2': { capabilities: ['tools'] } } } }
```

**`tests/router-config.test.ts`**

```typescript
// glmModel 旧：
const glmModel: ModelConfig = { provider: 'zhipuai', capabilities: ['tools'], contextWindow: 128_000 };
// glmModel 新：
const glmModel: ModelConfig = { capabilities: ['tools'], contextWindow: 128_000 };

// cfg() helper 旧：
models: { 'glm-5.2': glmModel }
// cfg() helper 新：
providers: { zhipuai: { protocol: 'openai', models: { 'glm-5.2': glmModel } } }
```

L62/67/68 的 `models:` 断言同步更新。

**`tests/skill-capture-config.test.ts`**

```typescript
// baseConfig() 旧：
function baseConfig(overrides = {}) { return { providers: {}, models: {}, ...overrides }; }
// baseConfig() 新：
function baseConfig(overrides = {}) { return { providers: {}, ...overrides }; }
```

**新增 `tests/providers/config-migration.test.ts`** — 迁移逻辑测试

```typescript
describe('migrateConfig', () => {
  it('旧格式 → 新格式', () => { /* 验证 models 搬入 providers */ });
  it('幂等：已迁移不重复处理', () => { /* providers 下已有 models 时跳过 */ });
  it('provider 不存在时跳过该模型', () => { /* 不崩，stderr 警告 */ });
  it('模型缺 provider 字段时跳过', () => { /* 不崩，stderr 警告 */ });
  it('同名模型全局唯一校验', () => { /* 重复时报错 */ });
});
```

### Phase 6: 用户配置

**`~/.ecode/config.json`** — 依赖迁移逻辑自动搬运旧配置，或删除后重启自动生成新模板。

---

## 旧格式迁移策略

`loadConfig()` 内 parse 后自动检测 + 转换 + 原子写回磁盘：

1. **检测**：`cfg.models` 非空 且 所有 `cfg.providers.*.models` 为空
2. **搬运**：遍历 `cfg.models`，按 `.provider` 字段搬到 `cfg.providers[provider].models[id]`
3. **校验**：`validateModelUniqueness` — 模型 ID 全局唯一
4. **清理**：删顶层 `cfg.models`
5. **持久化**：写临时文件 `config.json.tmp` + `renameSync`（原子操作）
6. **提示**：stderr 输出 `🔄 检测到旧版 config.json 格式，已自动迁移`

**幂等**：已迁移的 config 再次 load 时跳过。
**容错**：rename 失败时删临时文件，内存中已转换的 config 照常使用（不阻塞启动）。

---

## 边界场景处理

| 场景 | 处理策略 |
|------|---------|
| provider 无 models 字段 | 合法——仅有凭证配置（如 claude），`listAvailableModels` 跳过 |
| defaultModel 指向不存在的模型 | loadConfig 时校验，stderr 警告并回退首个可用模型 |
| 多 provider 同名模型 | `validateModelUniqueness` 加载时报错，拒绝启动 |
| 旧格式 provider 字段缺失/错误 | 跳过该模型 + stderr 警告，不崩 |
| 迁移写回失败（权限/磁盘满） | 删临时文件，内存中新格式照常使用 |

---

## 实施顺序

```
types.ts (删 provider)
  → config.ts (类型 + DEFAULT_CONFIG + 迁移 + 校验 + 函数重写)
    → factory.ts (适配 ModelResolution)
      → router/config.ts (适配嵌套结构)
        → app.tsx (适配 .config + 修 StatusBar bug)
          → 测试更新 + 新增迁移测试
            → tsc 编译验证
              → npm test 全量验证
```

---

## 验证

1. `npx tsc --noEmit` 编译通过
2. `npm test` 全部通过
3. 删除 `~/.ecode/config.json` 重启，验证新模板格式正确
4. 手动写一个旧格式 config.json 验证自动迁移
5. `/model` 命令能列出所有 provider 下的模型
6. StatusBar 正确显示 `model @ provider`
7. 写一个多 provider 同名模型 config 验证报错
