---
layer: core
status: review
related_adr: [ADR-021, ADR-022, ADR-023, ADR-024, ADR-025]
reviewed_doc: [详设/2026-08-11_ECode-MVP详设_待审核.md]
---

# ECode MVP 配置系统与多 Provider 解析

> 解析日期：2026-08-11 · 状态：待审核
> 记录「npm 发布 → 配置分层 + JSONC + 多 provider 多模型 + `/model` 跨 provider 切换 + MVP 实现两协议」的方案对比、被否决备选与决策论证。
> 结论已落入详设 0.4 / 2.2 / 4.1 / 4.3 / 7 / 9 / 10。

## 总览：本轮 5 个决策

| # | 决策点 | 结论 | 对应详设 |
|---|---|---|---|
| 1 | 配置位置 | 用户级 `~/.ecode/config.json`（全局 CLI 主配置）；`.env` 降为 dev 专用 | 4.1 |
| 2 | 配置格式 | JSONC（`jsonc-parser` 解析，支持注释） | 4.1 |
| 3 | Provider 架构 | 两层：`type`→实现（Registry）+ `name`→配置实例（config） | 2.2 |
| 4 | MVP 协议范围 | 实现 anthropic + openai **两协议**（原 1 个 → 2 个） | 0.4 / 10 |
| 5 | `/model` 切换粒度 | 跨 provider 平铺所有 provider×model，一键切 | 4.3 |

---

## 决策 1：配置位置 → 用户级 config.json

### 问题陈述
ECode 要 npm 发布为**全局 CLI**（`npm install -g ecode`），用户在任意目录 `ecode` 启动。原设计的 `.env`（项目级，就近读取）在全局 CLI 场景下找不到——任意目录通常没有 `.env`。需重新定配置位置。

### 备选方案

**A. 用户级 `~/.ecode/config.json`（主）+ `.env`（dev 专用）**
- ✅ 全局 CLI 主配置在用户目录，任意位置启动都能读到；`os.homedir()` 跨平台
- ✅ `.env` 保留给 `npm run dev`（开发期快速覆盖）；全局版不读 `.env`
- ❌ 需首次运行向导（无 config 时引导生成）

**B. 纯项目级 `.env`（保持原设计）**
- ❌ 全局 CLI 在任意目录启动，多数目录无 `.env` → 配置失效
- ❌ 用户要每个项目都放 `.env`，重复

**C. 项目级 `.ecode.json`（cwd）+ 用户级 config**
- ❌ 用户明确不需要项目级（"只需要用户级别"）；增加复杂度

### 论证
- 对标业界全局 CLI：Claude Code（`~/.claude.json`）、Aider（`~/.aider.conf.yml`）、git（`~/.gitconfig`）都是用户级配置为主。
- `.env` 不删，定位为**开发期**（`npm run dev` 先读 `.env` 覆盖 config），兼顾开发便捷与全局可用。

### 结论
**选 A。** 优先级分两套：
- `npm run dev`：CLI > 进程 env > **`.env`** > `~/.ecode/config.json` > 默认
- 全局 `ecode`：CLI > 进程 env > `~/.ecode/config.json` > 默认（不读 `.env`）

### 反驳
**风险**：多设备同步配置要手动拷 `~/.ecode/config.json`（不像项目级随 git 走）。
**缓解**：config 不大，手动拷 / dotfiles 仓库管理；后续可考虑 config 导入导出命令。

---

## 决策 2：配置格式 → JSONC

### 问题陈述
用户要求 config **支持注释**。纯 JSON 不支持注释，需选格式。

### 备选方案

| 格式 | 注释 | 宽松度 | 编辑器 | 解析库 |
|---|---|---|---|---|
| **JSONC**（JSON + 注释 + 尾逗号） | ✅ | 中 | ✅（VSCode 同款，.json 默认容忍） | `jsonc-parser`（成熟） |
| JSON5 | ✅ + 单引号/hex/尾逗号 | 高 | ⚠️（.json5 支持弱） | `json5` |
| YAML | ✅ | 高（缩进敏感） | ✅ | `js-yaml`（缩进易错） |
| TOML | ✅ | 中（段式） | ✅ | `toml`（嵌套深时不便） |

### 论证
- 配置是嵌套结构（providers map），JSONC 的对象/数组表达最直接。
- 注释 + 尾逗号已满足用户需求，不需要 JSON5 的单引号等额外宽松。
- `jsonc-parser` 是 VSCode 同款，最成熟；文件名仍用 `.json`（编辑器友好），解析用 jsonc-parser 容忍注释。

### 结论
**选 JSONC。** 文件 `~/.ecode/config.json`，用 `jsonc-parser` 解析。被否决：JSON5（过宽松易出错、编辑器支持弱）、YAML（缩进坑）、TOML（嵌套不便）。

### 反驳
**风险**：用户误写非法 JSONC（如多余逗号在严格 JSON 工具下报错）。
**缓解**：首次加载时校验 + 友好报错（指明行列）；`jsonc-parser` 容错性强。

---

## 决策 3：Provider 架构 → 两层（type 实现 + name 配置）

### 问题陈述
多 provider 下，多个配置实例可能共享同一协议（deepseek 和 openai 都用 openai 协议）。原设计「Provider = 单实例，register 时绑定 baseURL/apiKey」不适用——同一协议实现要服务多个不同端点/密钥的实例。

### 备选方案

**A. 两层：实现（按 type）+ 配置实例（按 name）**
- 实现层：`type:'anthropic'` → `AnthropicProvider`，`type:'openai'` → `OpenaiProvider`。**无状态**，按请求注入配置。
- 配置层：config 的 `providers.astron`/`providers.deepseek` 各绑定一个 type + baseURL/apiKey/models。
- AgentLoop：`current`(name+model) → 取 config → 按 type 找实现 → 注入配置 → `run()`。

**B. 单实例（每个 config provider 注册一个 Provider 实例）**
- ❌ 启动时为每个 config provider new 一个实例；切换 = Registry.get(name)。但 Provider 实例绑死了配置，换端点要重建实例；实现类与配置耦合。

### 论证
- 两层让**实现无状态**（同一 OpenaiProvider 类服务 deepseek 和 openai 两个实例），符合「实现可复用、配置可变」。
- 心脏仍只认 `type` 找实现，不认识具体厂商名——铁律不变。
- `/model` 切换只改 `current`（name+model），不动实现、不重建实例。

### 结论
**选 A：两层。**
- `LLMProvider` 实现按 `type` 注册（`anthropic`/`openai`）。
- `run(req)` 接收完整配置（`baseURL`/`apiKey`/`model`/...），实现按 req 实例化 client（`new Anthropic({ baseURL, apiKey })`），不在构造时绑定。

### 反驳
**风险**：每次 run new 一个 SDK client 有开销。
**缓解**：client 可按 `name` 缓存（首次创建复用）；SDK client 构造轻量。

---

## 决策 4：MVP 协议范围 → anthropic + openai 两协议

### 问题陈述
用户要 `/model` 跨 anthropic/openai/deepseek/glm 一键切换。这些厂商覆盖两种协议（anthropic 兼容 / openai 兼容）。原 MVP 只实现 anthropic 协议（openai.ts 是占位）。要让切换真正生效，必须实现两个协议。

### 备选方案

**A. MVP 实现 anthropic + openai 两协议**
- ✅ config 多 provider 全部生效；`/model` 真跨厂商切（glm↔deepseek↔openai）
- ❌ openai 协议翻译有真实工作量（+3~5 天）：system 塞 messages、tool_use↔tool_calls（function wrapper）、tool_result→role:'tool'、tools 数组包装、流式 chunk→Delta 映射、两套 M1 烟测

**B. MVP 只 anthropic 协议，config 框架支持多 provider**
- ❌ type=openai 的切换报「协议未实现」；实际只能切同协议的多个 anthropic 兼容端点
- ✅ 工作量小

**C. 框架（config + /model 跨 provider UI）全到位，openai 实现留 M3 后补**
- ✅ 架构完整，切换到未实现 type 时友好报错
- ❌ 「能切但切了报错」体验差

### 论证
- 用户明确要「不管 anthropic/openai/deepseek/glm 都能一键切换」——B/C 都兑现不了这个承诺。
- 两协议实现后，覆盖主流厂商：anthropic 类（GLM 经 Astron、Anthropic 官方）、openai 类（OpenAI、DeepSeek、Moonshot、智谱 OpenAI 兼容端等）。
- 工作量 +3~5 天可接受（规范模型已隔离，openai 协议翻译是纯 Provider 内部工作，不碰心脏）。

### 结论
**选 A：MVP 实现两协议。** 范围调整：原「非目标：多 provider」→「**多 provider 切换是 MVP 目标，多 provider 路由仍非目标**」。`openai.ts` 从占位升为 MVP 实现。

### 反驳
**风险**：openai 协议 + 流式翻译的 M1 烟测要单独做（OpenAI 兼容端点的 stream chunk 格式、tool_calls 分片），双协议烟测工作量翻倍。
**缓解**：M1 先 anthropic 跑通（含 Astron/GLM），openai 协议放 M3 与工具命令同期（deepseek/openai 烟测）；两协议烟测清单分开列。

---

## 决策 5：`/model` 切换粒度 → 跨 provider

### 问题陈述
`/model` 切换的是「同 provider 的 model 名」还是「连 provider 一起切」？多 provider 下，用户要在不同厂商间切（如 glm→deepseek）。

### 备选方案

**A. 跨 provider 平铺：列出所有 provider×model，选中即切（连 provider 一起）**
- ✅ 真一键切厂商；UX 直观（一个列表选）

**B. 两步：先 `/provider` 选厂商，再 `/model` 选模型**
- ❌ 两步操作，繁琐

**C. 只切 model 名（provider 固定）**
- ❌ 无法跨厂商；多 provider 形同虚设

### 论证
- 用户原话「不管 anthropic 还是 openai 不管 deepseek 还是 glm 都能一键切换」= 明确要 A。
- 平铺列表项格式：`provider / model`（如 `deepseek / DeepSeek-V4-Pro`），当前项高亮。

### 结论
**选 A。** `/model` 展开所有 `providers[].models` 的笛卡尔积，每项 `name / model`，选中改 `current = { name, model }`，下次 `provider.run()` 用新配置。

### 反驳
**风险**：provider×model 很多时列表长。
**缓解**：Ink Select 支持搜索/模糊匹配（`@inkjs/ui` Select 或自建 fuzzy）；MVP provider 数量少，不成问题。

---

## config.json 完整样例（JSONC）

```jsonc
{
  // 启动默认选中的 供应商+模型（model 用 API 字段）
  "default": { "provider": "astron", "model": "glm-5.2" },

  // 供应商：key=自定义名字，value 含协议类型/端点/密钥/可选模型/采样参数
  "providers": {
    "astron": {                              // GLM 经 Astron 的 Anthropic 兼容端点
      "type": "anthropic",                   // 协议：anthropic | openai（决定用哪个 Provider 实现）
      "baseURL": "https://astron-endpoint/v1",
      "apiKey": "sk-xxx",
      "models": ["glm-5.2", "glm-4.7-flash"],   // API model 字段，按智谱官方(docs.bigmodel.cn)
      "temperature": 1.0, "topP": 0.95,          // 二选一调(官方建议)
      "thinking": "max",                          // GLM-5.x 推理强度：max|high|enabled
      "maxTokens": 8192
    },
    "glm-openai": {                          // ★ 同一个 GLM-5.2 也可走官方 OpenAI 协议（主流模型双协议）
      "type": "openai",
      "baseURL": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "sk-xxx",
      "models": ["glm-5.2"],
      "temperature": 1.0, "topP": 0.95, "maxTokens": 8192
    },
    "deepseek": {                            // DeepSeek，OpenAI 兼容（也支持 Anthropic 接口）
      "type": "openai",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-yyy",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"],  // 按官方最新
      "temperature": 1.0, "topP": 0.95, "maxTokens": 8192
    }
    // 其它厂商(OpenAI 等)按其官方当前主力型号配置；型号会迭代，以官方最新为准，不写死
  },

  // 全局
  "maxIterations": 50,                       // 循环最大次数(可配)
  "bashMaxOutputBytes": 30720,               // bash 工具输出截断(默认 30KB,可配)
  "logLevel": "info"
}
```

> **型号不写死原则**：模型迭代快（ECode 当前基准 GLM-5.2 / DeepSeek-V4-Pro，2026-08），config 样例只作结构示例；型号以各厂商官方最新为准（[智谱新品发布](https://docs.bigmodel.cn/cn/update/new-releases) / [DeepSeek 更新日志](https://api-docs.deepseek.com/zh-cn/updates)）。

## 模型适配要点（GLM-5.2 / DeepSeek-V4-Pro · 基于官方文档 · 2026-08）

> 两步法调研：① 用「最新主力」关键词确认当前版本（GLM-5.2 / DeepSeek-V4-Pro）② 基于最新版本搜官方细节。以下均来自官方一手源，型号/参数以官方最新为准。

### GLM-5.2（智谱当前旗舰）
| 项 | 值/说明 | 来源 |
|---|---|---|
| API model 字段 | `glm-5.2` | [迁移指南](https://docs.bigmodel.cn/cn/guide/start/migrate-to-glm-new) |
| temperature / topP | 默认 1.0 / 0.95，**二选一调** | 迁移指南 |
| thinking | 推理强度 max\|high\|enabled（默认 max） | 迁移指南 |
| **stream-tool** | 流式工具调用（实时返回工具调用信息） | [stream-tool 文档](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool) |
| 上下文 | 1M 无损，针对长程 Coding Agent 强化 | [模型页](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2) |
| 协议 | 原生 OpenAI 协议 + Anthropic 兼容端点（Astron） | 官方 |

### DeepSeek-V4-Pro（DeepSeek 旗舰）
| 项 | 值/说明 | 来源 |
|---|---|---|
| API model 字段 | `deepseek-v4-pro`（Flash 是 `deepseek-v4-flash`） | [更新日志](https://api-docs.deepseek.com/zh-cn/updates) |
| **strict 模式** | Tool Calls 支持严格 JSON Schema | [Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) |
| 协议 | **同时支持 OpenAI ChatCompletions 与 Anthropic 接口** | 更新日志 |
| 上下文 | 原生百万级（1.6T 总参 / 49B 激活） | [阿里云模型规格](https://help.aliyun.com/zh/model-studio/deepseek-v4-pro) |
| Agent | 并行 3-4 工具，参数准确性实测好 | 第三方实测 |

### ECode 适配动作
- **config 暴露采样参数**（per provider）：`temperature` / `topP` / `thinking`(GLM) / `maxTokens`——调准确性的主杠杆。
- **GLM（经 Astron）**：启用 **stream-tool**（流式工具调用）→ ECode 流式 JSON 拼接（`tool_use_delta`）的官方依据。⚠️ M1 烟测确认 Astron 端点透传。
- **DeepSeek**：启用 **strict 模式**（严格 JSON Schema）→ 提升工具 input 准确性，呼应扁平 schema 决策。
- **双协议灵活性**：同一模型可配多个 provider 实例用不同 `type` 接入（见上 config 的 `astron` + `glm-openai`），按端点稳定性/特性/成本选——正是两层 Provider 架构的收益。
- **M1 烟测补充**：GLM-5.2 stream-tool 透传、DeepSeek strict 行为（见详设 10 烟测清单 ⑧⑨）。

> 官方文档入口（版本相关）：智谱 `docs.bigmodel.cn` / DeepSeek `api-docs.deepseek.com`。模型迭代快，型号/参数以官方最新为准（呼应「型号不写死原则」）。

---

## 发布形态（npm）

```jsonc
// package.json
"scripts": {
  "dev":   "tsx src/cli/index.ts",         // 开发：跑源码，读 .env + config
  "build": "tsc",                           // 编译到 dist/
  "start": "node dist/cli/index.js",        // 本机 build 后跑（测试 LLM）
  "prepublishOnly": "npm run build"         // 发布前自动 build
},
"bin":   { "ecode": "dist/cli/index.js" },  // shebang #!/usr/bin/env node
"files": ["dist", "package.json", "README.md"],
"engines": { "node": ">=18" }
```

- 开发：`npm run dev`（tsx + .env 覆盖）。
- 本机测试：`npm run build && npm start`，或 `npm link` 后 `ecode`。
- 发布：`npm publish`（prepublishOnly 自动 build，发 dist）。
- 「tsx 跑源码」是开发期约定，发布期编译——两者不矛盾。

## 附：本轮决策与 ADR 对应

| 决策 | ADR |
|---|---|
| 配置位置（用户级 + .env 降级） | ADR-021 |
| 配置格式 JSONC | ADR-022 |
| Provider 两层（type 实现 + name 配置） | ADR-023 |
| MVP 两协议（anthropic + openai） | ADR-024 |
| /model 跨 provider 切换 | ADR-025 |

> 待后续在 `docs/决策/` 逐条落盘（只追加不改）。
