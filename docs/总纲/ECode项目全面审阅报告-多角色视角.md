# ECode 项目全面审阅报告 — 多角色视角（含优化方案）

> **审阅时间**：2026-08-11（v2 重做：v1 有 6 处论断未经核实即写入，已全部纠正，见 §十）
> **审阅范围**：架构、UI、具体实现、测试、工程化、交付
> **审阅视角**：架构师 / 资深开发 / 产品经理 / 测试 / 交付
> **核实基线**：`tests/` 88 个测试文件 · `src/` 113 个 ts/tsx 共 13.5K 行 · `docs/` 220 篇 md · tsc strict clean

---

## 执行摘要

ECode 的**架构与文档是同类个人项目里少见的扎实**：核心 agent loop 从 M1 到 M6 未被改动，新能力（Provider / 权限 / 子代理 / MCP / Hooks / Skills）全靠挂载生长，"不动的心脏 + 可挂载外挂"不是口号而是有生长史可验证的事实。测试 88 文件 1053 例，权限、MCP 进程清理这类高危模块都有专项覆盖。

**真实短板不在"缺功能"，而在三处工程基建缺位**：

| 短板 | 实证 | 后果 |
|---|---|---|
| **无 CI** | 无 `.github/workflows` | 1053 单测全靠本地自觉跑；跨平台（Win/WSL/Linux）声称支持但无矩阵验证 |
| **无 lint/prettier 配置** | 无 `.eslintrc*` / `eslint.config.*` / `.prettierrc*` | CLAUDE.md §4.5 明文要求"ESLint + Prettier 统一风格"，规范与落地脱节 |
| **无覆盖率度量** | package.json 无 coverage | 1053 是绝对数，不知道哪里是盲区（如 agent.ts 1001 行核心的分支覆盖未知） |

这三项都是**一次性投入、长期收益**，且是开源项目吸引外部贡献的前提（贡献者提 PR 需要自动校验兜底）。

**其次是两处代码结构债**：`agent.ts` 1001 行（最大文件，承担 loop + 权限编排 + 熔断 + 路由 + 压缩重试至少 5 类职责）、`ui/app.tsx` 629 行 11 个 useState。两者都还在"能维护"区间，但已接近临界。

**评分**：架构 ⭐⭐⭐⭐⭐ · 代码质量 ⭐⭐⭐⭐☆ · 测试 ⭐⭐⭐⭐☆ · 工程基建 ⭐⭐☆☆☆ · 文档 ⭐⭐⭐⭐⭐ · 交付就绪 ⭐⭐⭐☆☆

---

## 目录

- [一、项目概况（核实数据）](#一项目概况核实数据)
- [二、架构师视角](#二架构师视角)
- [三、资深开发视角](#三资深开发视角)
- [四、测试视角](#四测试视角)
- [五、产品与交付视角](#五产品与交付视角)
- [六、问题清单（按 ROI 排序）](#六问题清单按-roi-排序)
- [七、优化方案（可直接落地）](#七优化方案可直接落地)
- [八、分阶段行动计划](#八分阶段行动计划)
- [九、明确不建议做的事](#九明确不建议做的事)
- [十、v1 报告勘误](#十v1-报告勘误)

---

## 一、项目概况（核实数据）

| 维度 | 数据 | 来源 |
|------|------|------|
| 源码 | 113 个 ts/tsx，13,534 行 | `find src` + `wc -l` |
| 测试 | 88 个测试文件，1053 例 | `find tests -name "*.test.ts"` |
| 文档 | 220 篇 md | `find docs -name "*.md"` |
| TS 严格度 | strict + noUnusedLocals + noUnusedParameters + noImplicitReturns + noFallthroughCasesInSwitch | tsconfig.json |
| README / CHANGELOG | 已有（185 / 64 行） | 仓库根 |
| CI | ❌ 无 | 无 `.github/` |
| lint / format | ❌ 无配置 | 无 eslintrc / prettierrc |
| 覆盖率 | ❌ 未度量 | package.json 无 coverage |
| Docker | ❌ 无 | 无 Dockerfile |

### 最大文件 Top 8（结构债定位）

| 文件 | 行数 | 职责数 | 评价 |
|------|------|--------|------|
| `src/agent.ts` | **1001** | ~5（loop / 权限编排 / 熔断 / 路由 / 压缩重试） | ⚠️ 最该拆 |
| `src/ui/app.tsx` | 629 | ~4（键位 / 弹窗编排 / 斜杠分发 / 渲染） | ⚠️ 接近临界 |
| `src/ui/use-agent-stream.ts` | 479 | 事件消费 | 可接受 |
| `src/context-manager.ts` | 479 | 压缩策略 | 可接受 |
| `src/providers/config.ts` | 475 | 配置加载 | 可接受 |
| `src/ui/input-bar.tsx` | 375 | 输入编辑 | 可接受 |
| `src/index.ts` | 364 | CLI 分流 | 可接受 |
| `src/ui/tool-panel.tsx` | 348 | 工具渲染 | 可接受 |

> 注：`ui/agent-loop-controller.ts` 已把 loop 编排从 app.tsx 抽出为 class（`AgentLoopController` + `ControllerCallbacks` + `ControllerDeps` 依赖注入），这是一次**已完成的、做得对的**解耦——app.tsx 的 629 行里已不含 loop 逻辑。

---

## 二、架构师视角

### 2.1 做得好的（不必动）⭐⭐⭐⭐⭐

**1. "心脏不动"有生长史可验证**

架构生长表（M1 立柱 → M2 Provider → M3 数据层 → M3.5 呈现层 → M4 权限门 → M5 扩展层）每一行的"心脏变了吗"都是"否"。这不是事后叙事——`runAgentStream` 作为异步生成器 + 9 种 `AgentEvent` 的契约，让 REPL / 无头 / 子代理三种消费方共用一个循环。**这是本项目最大的资产，任何重构都不该破坏它。**

**2. 依赖注入到位，可测性是设计出来的**

`runAgentStream` 的 options 可注入 `provider`（mock）/ `permissionGate`（无 UI）/ `signal`（中断）/ `allow`（权限）；`AgentLoopController` 用 `ControllerDeps` + `ControllerCallbacks` 显式声明依赖；`formatRelativeTimeAgo(iso, now)` 把 `Date.now()` 提到参数——**为了可确定断言而设计签名**，这是有测试意识的写法。

**3. 声明式工具注册**

`registry.ts` 挂 schema + execute，`executor.ts` 纯 find 分发无 switch。加工具只改一处，这个约束经 M5（子代理 Task / MCP adapter 注入）验证仍然成立。

### 2.2 🟡 A-1：`agent.ts` 1001 行职责过载

**实证**：单文件 import 了 40+ 个模块，涵盖 tools / subagent / skills / hooks / vision-fallback / validation / providers / router / skill-capture / context-manager / runtime-logger / session / permission 共 13 个子系统。

**问题**：这不是"文件太长"的美学问题，而是**核心心脏被非核心关切包围**——`MCP_TOOL_ERROR_DISABLE_THRESHOLD` 熔断、图片降级策略、路由决策、技能观测记录，这些都不是 loop 的本质职责。将来任何一个子系统改动都要打开这个 1001 行文件，**违背了"心脏不动"原则的精神**（物理上没动逻辑，但文件已成为耦合点）。

**优化方案**见 §7.5。

### 2.3 🟢 A-2：模型能力探测散落，未收口到 Provider

**实证**：`agent.ts` 直接 import `resolveImageStrategy`（vision-fallback）、`hasCapability`、`getMaxIterations`。

**问题**：核心 loop 在做"这个模型支不支持图片"的判断，属于 Provider 层的知识泄漏到核心。

**方案**：`ModelProvider` 接口增 `capabilities: ModelCapabilities` 字段，把 `hasCapability` / `resolveImageStrategy` / `getMaxIterations` 三处查询收口为 `provider.capabilities.*`。核心只问 provider，不问 config。改动小（3 个调用点），收益是核心不再 import config。详见 §7.10。

### 2.4 🟢 A-3：配置无 schema 校验，错配置静默降级

**实证**：`config.ts` 的策略是"读 `~/.ecode/config.json`，不存在用内置默认（开箱可用）"。开箱可用是对的，但**存在但写错**的配置（拼错 key、类型错、baseURL 少 `/v1`）会静默走默认值或运行时才炸。

已有一个真实踩坑印证：debugging #018「模型名大小写不敏感 → `getContextWindow` 兜底 128K」——正是配置侧静默兜底导致的误导。

**方案**见 §7.7。

---

## 三、资深开发视角

### 3.1 做得好的（不必动）

- **注释解释 Why 而非 What**：`generateSessionId` 的注释写清了"为什么不用时间戳"（同秒碰撞 → 覆盖失效 → 静默丢数据）+ UUID 碰撞概率量化 + 三方参考。这是可以直接进教科书的注释。
- **常量带决策依据**：`MCP_TOOL_ERROR_DISABLE_THRESHOLD` 的注释解释了为何只对 `mcp__` 前缀生效（内置工具失败是业务常态，误杀代价大）。
- **错误恢复四层级联**：工具级 `isError` 回喂 → API 级指数退避 → 上下文级 `forceCompact` → 熔断级终止。层次清晰，每层有出口。

### 3.2 🟡 B-1：无 lint / prettier，规范与落地脱节

**实证**：CLAUDE.md §4.5 写明"ESLint + Prettier 统一代码风格，提交前自动格式化"，但仓库无任何配置文件。

**为什么这是真问题（而非洁癖）**：
1. 开源项目收外部 PR 时，风格争论会消耗 review 精力；
2. `noUnusedLocals` 只管未用变量，管不了 `import` 顺序、`any` 泄漏、`await` 漏加、Promise 未处理；
3. 无 formatter → diff 里混入格式噪音，掩盖真实改动。

**方案**见 §7.2。

### 3.3 🟢 B-2：`formatTime` 与 `formatRelativeTimeAgo` 职责重叠但不重复

**实证核对**：`index.ts:100 formatTime`（ISO → `YYYY-MM-DD HH:mm:ss` 绝对时间，CLI `--sessions` 表格用）与 `ui/format-time.ts formatRelativeTimeAgo`（相对时间，`/resume` 列表用）**是两个不同需求，不是重复实现**（v1 报告在此处判断有误）。

**仍建议**：把 `index.ts` 的 `formatTime` 挪进 `ui/format-time.ts`（或新建 `src/format-time.ts` 供两侧共用），理由是同类格式化聚在一处、且 `formatTime` 目前在 CLI 文件里属于杂项。**低优先级，属整理不属修 bug。**

### 3.4 🟢 B-3：`--help` / `--version` 未实现

**实证**：`parseArgs` 的 options 无 `help` / `version`；`printUsage()` 只在"无任务 + 非 TTY"路径被调用，走 `console.error` + `exit(1)`。

**后果**：`ecode --help` 会因未知 flag 被 `parseArgs` 抛错（strict 默认 true），用户拿到的是异常而非帮助。这是 CLI 的**基本礼节缺失**，对首次使用者不友好。

**方案**见 §7.3（10 分钟可修）。

---

## 四、测试视角

### 4.1 做得好的 ⭐⭐⭐⭐☆

**88 文件 1053 例，且高危模块有专项覆盖**（v1 报告误判"权限无测试"，实为 9 个文件）：

```
tests/permission/          arity · check-integration · dangerous-bash · doom-loop
                           path-guard · rule-engine · settings-loader · wildcard  (8)
tests/permission.test.ts                                                          (1)
tests/mcp-*.test.ts        adapter · client · manager · process-cleanup · registry (5)
tests/paths.test.ts        （resolveDataDir 跨平台）
tests/hooks-*.test.ts      inject · runner · settings
tests/agent-*.test.ts      events · hooks · stream · tools-injection
```

`vitest.config.ts` 里 `FORCE_COLOR: '1'` 附带注释解释"ink fake stdout 无 isTTY → chalk 关色 → lastFrame 断言失效"——**测试基建本身带踩坑注释**，说明测试是认真写的不是凑数的。preferences.md 还沉淀了"防假绿 5 条 testing 约定"。

### 4.2 🔴 C-1：无覆盖率度量（唯一真正的测试短板）

**实证**：package.json 无 `@vitest/coverage-v8`，无 coverage script。

**为什么重要**：1053 是绝对数，**不知道分布**。`agent.ts` 1001 行含 4 层错误恢复级联 + 4 种终止路径 + 熔断，这些分支是否被覆盖是未知的——而它们恰恰是"出问题最贵"的路径（错误恢复没测到 = 真出错时行为不明）。

**方案**见 §7.1。

### 4.3 🟡 C-2：无端到端流程测试

**实证**：`tests/` 全是单元/集成粒度，无 `tests/e2e/`。`scripts/` 只有 `verify-vision.ts` 一个手动验证脚本。

**现有替代**：M6 阶段 B 做过"真实 GLM 端到端连通验证"，但那是**一次性手动验证**，不是可回归的自动化测试。

**方案**见 §7.8（VCR 录制回放，不烧真实 token）。

### 4.4 🟢 C-3：`mcp-client` flaky 测试已被排除

**实证**：MEMORY.md 记载"1053 单测（97 文件，排除 flaky mcp-client）"，但 `tests/mcp-client.test.ts` 文件存在。

**建议**：排除方式应显式化——在 `vitest.config.ts` 的 `exclude` 里写明并附注释说明 flaky 原因（当前靠记忆文档记录，新贡献者不知道）；或改用 `describe.skip` + 原因注释。**让排除在代码里可见，而非只在记忆里。**

---

## 五、产品与交付视角

### 5.1 🟡 D-1：首次使用无引导，配置靠读文档

**实证**：无 `ecode init` / `ecode doctor` 命令（grep `'init'` / `doctor` / `health` 于 index.ts 与 slash-commands.ts 均无结果）。config 缺失时走内置默认（开箱可用 ✅），但 **API Key 缺失只会在首次调用时才暴露**。

**方案**见 §7.6（`ecode doctor` 一条命令自检配置 + 连通性）。

### 5.2 🟢 D-2：无 CI badge / 无自动发布

README 有 185 行（不缺），但作为开源项目缺少"这个项目是活的且质量可信"的信号：CI 状态、测试数、npm 版本 badge。CI 建好后顺手加。

### 5.3 🟢 D-3：无 Docker（低优先级）

**判断**：CLI 工具的主要分发渠道是 npm 全局安装，Docker 对 coding agent 反而别扭（要挂载工作区、传 API Key、失去本地 shell 上下文）。**v1 报告把此项列 P2 偏高，实际应为"可选，非必需"**。真需要时再补。

---

## 六、问题清单（按 ROI 排序）

| # | 问题 | 严重度 | 投入 | 收益 | 优先级 |
|---|------|--------|------|------|--------|
| C-1 | 无覆盖率度量 | 🔴 | 30min | 暴露测试盲区，指导后续补测 | **P0** |
| — | 无 CI | 🔴 | 1h | 88 测试文件自动跑 + 跨平台矩阵 | **P0** |
| B-1 | 无 lint/prettier | 🟡 | 1h | 规范落地，PR 免风格争论 | **P0** |
| B-3 | `--help`/`--version` 缺失 | 🟡 | 10min | CLI 基本礼节 | **P0** |
| A-1 | agent.ts 1001 行职责过载 | 🟡 | 4h | 核心解耦，改子系统不碰心脏 | P1 |
| D-1 | 无 `ecode doctor` 自检 | 🟡 | 2h | 首次使用门槛，排障成本 | P1 |
| C-2 | 无 E2E 回归测试 | 🟡 | 4h | 防跨模块回归 | P1 |
| A-3 | 配置无 schema 校验 | 🟢 | 2h | 错配置早暴露（治 #018 类坑） | P1 |
| C-3 | flaky 排除不显式 | 🟢 | 15min | 新贡献者可见 | P2 |
| A-2 | 模型能力未收口 Provider | 🟢 | 1.5h | 核心不 import config | P2 |
| B-2 | formatTime 位置杂项 | 🟢 | 15min | 整理 | P3 |
| D-3 | 无 Docker | 🟢 | — | 可选，非必需 | P3 |

---

## 七、优化方案（可直接落地）

> 每项给：改哪里 · 怎么改 · 验收标准。按 ROI 顺序，可独立实施。

### 7.1 【P0 · 30min】接入覆盖率度量

**改哪里**：`package.json` + `vitest.config.ts`

```jsonc
// package.json
"devDependencies": {
  "@vitest/coverage-v8": "^2.1.8"   // 与 vitest 2.1.8 大版本对齐
},
"scripts": {
  "test": "vitest",
  "test:run": "vitest run",                    // 顺手治 debugging #016（npm test 是 watch）
  "test:cov": "vitest run --coverage"
}
```

```ts
// vitest.config.ts — 在 test 里加
coverage: {
  provider: 'v8',
  reporter: ['text', 'html', 'json-summary'],
  include: ['src/**/*.{ts,tsx}'],
  exclude: ['src/**/*.test.ts', 'src/ui/logo.tsx', 'src/**/types.ts'],
  // 首次不设 thresholds——先看真实基线，再按基线略高设阈值（避免一上线就红）
}
```

**验收**：`npm run test:cov` 输出覆盖率表；记录 `agent.ts` / `context-manager.ts` / `permission/*` 三处的分支覆盖率作为基线，写入 `docs/memory/project.md`。

**下一步（看到基线后）**：给 `agent.ts` 的 4 层错误恢复 + 4 种终止路径补分支测试，目标这两块 branch ≥ 85%（核心路径高标准，UI 层不强求）。

---

### 7.2 【P0 · 1h】补 ESLint + Prettier（落实 CLAUDE.md §4.5）

**改哪里**：新建 `eslint.config.js`（flat config，ESLint 9 标准）+ `.prettierrc.json`

```js
// eslint.config.js
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'ui-preview.tsx'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // 对齐 CLAUDE.md §4.1「禁止 any，不得已用 unknown」
      '@typescript-eslint/no-explicit-any': 'error',
      // 治真 bug 类：漏 await 的 Promise
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // 对齐 CLAUDE.md §1.2「禁止吞异常」
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  prettier,   // 放最后，关掉与 prettier 冲突的风格规则
);
```

```jsonc
// .prettierrc.json —— 贴合现有代码风格（单引号、120 宽、分号），避免全量重排
{ "singleQuote": true, "printWidth": 120, "semi": true, "trailingComma": "all" }
```

```jsonc
// package.json scripts
"lint": "eslint src tests",
"format": "prettier --write \"src/**/*.{ts,tsx}\" \"tests/**/*.ts\"",
"format:check": "prettier --check \"src/**/*.{ts,tsx}\" \"tests/**/*.ts\""
```

**关键实施顺序**（避免一次性巨型 diff 污染 git 历史，呼应 CLAUDE.md §七"提交时机"）：
1. 先只加配置，跑 `npm run lint` 看报多少条；
2. `npm run format` 单独一个 commit（`style: 接入 prettier 统一格式`），**不夹带任何逻辑改动**；
3. lint 报错分批修，每批一个 commit。

**注意**：`recommendedTypeChecked` 需要类型信息，首次跑较慢（约 20-40s）。若嫌慢可先用 `recommended`（无类型检查），但会失去 `no-floating-promises` 这类最有价值的规则——**建议忍受耗时**。

**验收**：`npm run lint` 零 error；`npm run format:check` 通过。

---

### 7.3 【P0 · 10min】补 `--help` / `--version`

**改哪里**：`src/index.ts`

```ts
const { values, positionals } = parseArgs({
  options: {
    // ...existing
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
});

// 放在 --list-models 之前（最优先分流）
if (values.help) { printUsage('out'); process.exit(0); }
if (values.version) { console.log(readAppVersion()); process.exit(0); }
```

**顺带修 `printUsage` 的问题**：帮助信息应走 `console.log`（stdout），`--help` 是成功路径不是错误——当前全用 `console.error`，会让 `ecode --help > help.txt` 拿到空文件。建议改签名为 `printUsage(stream: 'out' | 'err')`：`--help` 传 `out` + exit 0，无参非 TTY 传 `err` + exit 1。同时在用法里补上 `--help` / `--version` 两行自身说明。

**验收**：`ecode --help` 打印用法并 exit 0；`ecode -v` 打印版本号；`ecode --help > f.txt` 文件非空。

---

### 7.4 【P0 · 1h】加 CI（GitHub Actions）

**改哪里**：新建 `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        # 直接兑现"跨平台支持"的声称——ECode 有 Windows/WSL 专属逻辑（bash.ts shell 分流、
        # process-cleanup taskkill vs pgrep、resolveDataDir），必须双平台跑
        os: [ubuntu-latest, windows-latest]
        node: [18, 22]      # engines 声明 >=18，就要证明 18 能跑
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}', cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit          # 类型门
      - run: npx vitest run            # 用 vitest run，不是 npm test（watch 会挂住 CI）
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
```

**为什么 matrix 是重点而非可选**：项目有大量平台分支代码（`bash.ts` 的 `where bash.exe` 探测、`process-cleanup` 的 taskkill/pgrep 双实现、`paths.ts` 的 WSL↔Windows home 自探测），这些在单平台本地永远只跑到一半。**Windows runner 是唯一能自动验证这些分支的手段。**

**预期首次会红**：Windows runner 上可能暴露 CRLF（debugging #011）或 bash 探测（#012）相关的隐藏失败——**这正是 CI 的价值**，红了是收益不是麻烦。

**验收**：PR 自动跑 4 个组合（2 OS × 2 Node）+ lint；README 加 CI badge。

---

### 7.5 【P1 · 4h】拆分 `agent.ts`（1001 行 → 目标 ≤ 400 行）

**原则**：**不改 loop 逻辑，只把非核心关切平移出去**。这是纯搬移重构，靠现有 1053 测试兜底（拆完测试必须全绿且零改动）。

| 抽出模块 | 搬什么 | 约行数 |
|---|---|---|
| `agent/tool-runner.ts` | 单个工具的执行编排：权限门 → hook Pre → execute → hook Post → 截断 → validation → failure-tracker 记账 | ~250 |
| `agent/circuit-breaker.ts` | `MCP_TOOL_ERROR_DISABLE_THRESHOLD` 熔断 + 已禁用工具集合 + doom-loop 协同 | ~80 |
| `agent/model-selection.ts` | 路由（`resolveAlias` / `resolveModelForScenario`）+ 图片降级（`resolveImageStrategy`）决策 | ~120 |
| `agent/context-retry.ts` | 上下文超限重试级联（`isContextWindowError` → `forceCompact` → MAX_CONTEXT_RETRIES 熔断） | ~90 |
| `agent/setup.ts` | 启动期装配：loadAgents / loadSkills / buildAgentsCatalog / buildSkillsCatalog / hook gate 组装 | ~120 |
| **`agent.ts` 保留** | **纯 loop：迭代 → 取流 → 收 tool_use → 委托执行 → 喂回 → 终止判定 + yield 事件** | **~350** |

**验收**（硬标准，任一不满足即回滚）：
1. `npx vitest run` 1053 例全绿，**且测试文件零改动**（改了测试说明行为变了，不是纯搬移）；
2. `npx tsc --noEmit` clean；
3. `agent.ts` 的 import 数从 40+ 降到 ≤ 15；
4. 真机跑一次完整任务（含工具调用 + 一次压缩），对比 `docs/logs/runtime/` 日志与重构前一致。

**风险控制**：一次只搬一块，每块搬完立即跑全量测试；5 块搬完后再一起 commit（呼应 §七"完成一个完整功能再提交"）。**建议在 §7.1 覆盖率接入后再做**——有覆盖率数据才知道搬移是否漏测。

---

### 7.6 【P1 · 2h】`ecode doctor` 配置自检

**改哪里**：新建 `src/doctor.ts` + `index.ts` 加分流

**输出示例**（每项 ✅/⚠️/❌ + 可操作修复建议）：

```
$ ecode doctor

配置
  ✅ config.json    ~/.ecode/config.json（3 个 provider，7 个模型）
  ⚠️ 数据目录       D:\Users\fjyu9\.ecode（WSL 侧探测到另一个 home，见 §9.3）
凭证（只查存在性与格式，不打印值）
  ✅ ZHIPUAI_API_KEY    已设置（32 位）
  ❌ DEEPSEEK_API_KEY   未设置 → config.json 中 deepseek provider 将不可用
                        修复：在项目 .env 加 DEEPSEEK_API_KEY=xxx
连通性（--online 才跑，默认跳过避免消耗额度）
  ✅ glm-5.2        200 OK, 412ms
扩展
  ✅ MCP            registry.json 2 个服务器，均连接成功
  ⚠️ Hooks          settings.json 有 1 个 hook 指向不存在的脚本 ./scripts/pre.sh
运行环境
  ✅ Node           v22.11.0（满足 >=18）
  ✅ shell          bash.exe 已找到（C:\Program Files\Git\bin\bash.exe）
```

**设计要点**：
- **凭证只报"是否设置 + 长度"，绝不打印值**（CLAUDE.md §9.2 红线，复用现有 `getMaskedConfig()` 思路）；
- 连通性检查默认关闭，`--online` 才发真实请求（尊重用户额度）；
- 每个 ❌ 必须带**可复制的修复动作**，不能只报"配置错误"；
- 退出码：全 ✅ → 0，有 ❌ → 1（可进 CI / 脚本判断）。

**顺带收益**：这个命令同时解决 D-1（首次使用引导）与 A-3（配置校验）——doctor 内部就是 schema 校验的消费方。

---

### 7.7 【P1 · 2h】配置 schema 校验

**改哪里**：`src/providers/config.ts`

**方案**：手写轻量校验（**不引 Zod**——项目哲学是手写核心 + 依赖克制，只校验一个 config 结构，引 Zod 收益不抵体积）：

```ts
/** 校验结果：错误让加载失败（早暴露），警告只提示（向前兼容未知字段）。 */
interface ConfigIssue { path: string; message: string; fix?: string; }

function validateConfig(raw: unknown): { config: ECodeConfig; issues: ConfigIssue[] } { /* ... */ }
```

**要覆盖的具体错配置**（都是真会发生的）：

| 错配置 | 当前行为 | 期望行为 |
|---|---|---|
| 模型名大小写不匹配（`GLM-5.2` vs `glm-5.2`） | 静默兜底 128K 上下文（**debugging #018 真实踩坑**） | ⚠️ 警告 + 提示实际匹配到哪个 |
| `baseURL` 少 `/v1` 后缀 | 运行时 404 | ⚠️ 警告"该端点通常需以 /v1 结尾" |
| 未知顶层字段（如旧版 `models`） | 静默忽略 | ⚠️ 警告 + 迁移提示（已有 models→providers 迁移设计，接上） |
| `cost` 字段类型错（字符串 `"0.5"` 而非数字） | 成本计算 NaN | ❌ 报错 |
| provider 引用了不存在的模型 | 运行时才炸 | ❌ 报错 |

**验收**：`tests/config-validation.test.ts` 覆盖上表 5 个场景；`ecode doctor` 展示 issues。

---

### 7.8 【P1 · 4h】E2E 回归测试（VCR 录制回放）

**改哪里**：新建 `tests/e2e/` + `tests/e2e/fixtures/`

**方案**：录制回放（不烧 token、可确定断言、CI 可跑）——这正是开发规划 P1-7 已识别的"LLM VCR"，现在落地：

```ts
// tests/e2e/replay-provider.ts
// 复用架构红利：runAgentStream 的 options 已支持注入 provider，无需改核心一行
export function replayProvider(fixture: RecordedSession): ModelProvider {
  let call = 0;
  return {
    async *stream() { yield* fixture.calls[call++].parts; },   // 逐帧回放录制的流
    async complete() { return fixture.calls[call++].message; },
  };
}
```

**必须覆盖的 5 条链路**（选取标准：跨模块 + 出错最贵）：

| # | 场景 | 验证什么 |
|---|------|---------|
| 1 | 单工具调用完整往返 | `tool_use.id` ↔ `tool_result.tool_use_id` 配对（CLAUDE.md 硬约束，不配对 API 400） |
| 2 | 多轮 + 上下文压缩触发 | 压缩后 messages 结构合法、CLAUDE.md 重注入、session 落盘 |
| 3 | 工具失败 → LLM 重试 → 成功 | 错误恢复第 1 层（`isError` 回喂）真的让 LLM 拿到错误 |
| 4 | 权限 deny → loop 正确继续 | 权限门拒绝后不死循环、不破坏 tool 配对 |
| 5 | 中断（abort）中途 | `signal.aborted` → 抛 AbortError → 落盘收尾，**配对不破**（P1-3 已识别难点） |

**录制方式**：加 `ECODE_RECORD=1` 环境变量，真实跑一次把 provider 的输入输出序列化进 `fixtures/*.json`。录制一次，长期回放。

**验收**：`npx vitest run tests/e2e` 全绿且不发网络请求。

---

### 7.9 【P2 · 15min】显式化 flaky 测试排除

**改哪里**：`vitest.config.ts`

```ts
exclude: [
  '**/node_modules/**',
  // mcp-client.test.ts: 真实 stdio 子进程启停有时序竞态，CI/慢机器上偶发超时。
  // 排除原因记录于 docs/memory/debugging.md；重写为 mock transport 后移除本行。
  'tests/mcp-client.test.ts',
],
```

**同时**：在 `docs/memory/debugging.md` 补一条 flaky 根因与重写计划（当前只在 MEMORY.md 一句"排除 flaky mcp-client"，无根因）。

---

### 7.10 【P2 · 1.5h】模型能力收口到 Provider

**改哪里**：`providers/types.ts` + `factory.ts` + `agent.ts` 三处调用点

```ts
// providers/types.ts
export interface ModelCapabilities {
  vision: boolean;
  toolUse: boolean;
  contextWindow: number;
  maxIterations: number;
}
export interface ModelProvider {
  readonly capabilities: ModelCapabilities;   // 新增
  stream(...): AsyncGenerator<ECodeStreamPart>;
  complete(...): Promise<ECodeMessage>;
}
```

`agent.ts` 移除 `import { hasCapability, getMaxIterations } from './providers/config.js'`，改用 `provider.capabilities.*`。`resolveImageStrategy` 改为接收 `provider.capabilities.vision` 而非自己查 config。

**验收**：`agent.ts` 不再 import `providers/config.js`；现有 vision-fallback 测试全绿。

---

## 八、分阶段行动计划

### 阶段一：工程基建（半天，P0 全清）

一次性投入，此后每个 PR 都受益。建议作为**独立 commit 系列**，不夹带功能改动。

- [ ] 7.1 覆盖率接入（30min）→ 记录基线到 `docs/memory/project.md`
- [ ] 7.3 `--help` / `--version`（10min）
- [ ] 7.2 ESLint + Prettier（1h，format 单独 commit）
- [ ] 7.4 CI + 跨平台 matrix（1h）→ README 加 badge

**阶段验收**：PR 自动跑 tsc + 1053 测试 × (Win/Linux) × (Node 18/22) + lint；本地 `npm run test:cov` 出覆盖率报告。

### 阶段二：结构与体验（2 天，P1）

- [ ] 7.5 拆 `agent.ts`（4h，纯搬移，测试零改动）
- [ ] 7.6 `ecode doctor`（2h）
- [ ] 7.7 配置 schema 校验（2h，接入 doctor）
- [ ] 7.8 E2E VCR 5 条链路（4h）

**阶段验收**：`agent.ts` ≤ 400 行；`ecode doctor` 能诊断出人为制造的 5 种错配置；E2E 离线全绿。

### 阶段三：收尾（半天，P2/P3）

- [ ] 7.9 flaky 显式化 + debugging 补根因（15min）
- [ ] 7.10 模型能力收口 Provider（1.5h）
- [ ] 按覆盖率基线给 `agent.ts` 错误恢复/终止路径补分支测试
- [ ] B-2 `formatTime` 归位（15min，可搭车任意 commit）

---

## 九、明确不建议做的事

审阅的价值一半在"该做什么"，一半在"别做什么"。以下是**看起来该改、实际不该改**的：

| 别做 | 为什么 |
|------|--------|
| **重构 agent loop 本体** | "心脏不动"是本项目最大资产，有 6 个里程碑的生长史验证。§7.5 的拆分是**把外围搬走**，loop 的 for 循环、配对逻辑、终止判定一行不改。 |
| **给 `app.tsx` 引入 Zustand/Redux** | 629 行 / 11 useState / **0 useEffect**，且 loop 编排已抽到 `AgentLoopController`。11 个 state 各自独立（弹窗开关、模型名、计时），没有跨组件共享困境——引状态库是为不存在的问题增加实体，违反 KISS/YAGNI。真到临界时优先拆子组件。 |
| **Docker 化** | CLI coding agent 的分发渠道是 npm 全局装。容器化要挂载工作区、传 Key、且失去本地 shell 上下文——对本工具是负收益。 |
| **换掉 cli-highlight / marked** | 能用、无安全告警、无性能瓶颈。换 shiki 要引 WASM/onig 体积。**没有触发条件的依赖升级是纯风险。** |
| **追求全局 80% 覆盖率** | 覆盖率是探照灯不是 KPI。该高的是 `agent.ts` 错误恢复、`permission/*`、`context-manager`；UI 渲染层堆测试凑数是浪费。**先看基线，再定分模块目标。** |
| **补 Roadmap / 插件生态规划文档** | `docs/` 已 220 篇，功能架构设计有 24 支点总表 + 优先级，规划不缺。**缺的是 CI 不是文档。** |

---

## 十、v1 报告勘误

v1（同日早先版本）有 6 处论断未核实即写入，全部纠正如下。留档以明确基线，避免后续引用错误结论：

| v1 论断 | 实际情况 | 错因 |
|---|---|---|
| 🔴"权限系统测试缺失，安全风险" | `tests/permission/` **8 个文件 + permission.test.ts**，含 rule-engine / path-guard / dangerous-bash / doom-loop / arity / wildcard / settings-loader / check-integration | 只在 `src/` 下找 `*.test.ts`，测试实际在 `tests/`；命令返回 0 时未追查 |
| "缺少 README.md / CHANGELOG.md" | 两者均存在（185 / 64 行） | 未检查仓库根 |
| "`bash.ts` 用 execSync 阻塞主循环" | 用的是 `spawn`，源码第 55 行注释明写"异步执行（不阻塞主线程 → 治 #3 UI 卡死）" | 未读文件即断言 |
| "MCP 进程清理测试覆盖不足" | `tests/mcp-process-cleanup.test.ts` 存在，另有 adapter/client/manager/registry 共 5 个 MCP 测试文件 | 同第 1 条 |
| "app.tsx 681 行，14+ useState，最大文件" | **629 行，11 useState，0 useEffect**；最大文件是 `agent.ts` **1001 行** | 未实测即估数 |
| "`formatTime` 与 `format-time.ts` 重复实现" | 两者需求不同（绝对时间 vs 相对时间），非重复 | 按文件名推断 |

**同时修正两处优先级误判**：Docker 从 P2 降为"不建议"（CLI 工具容器化负收益）；"缺产品文档"整条撤销（README/CHANGELOG/使用指南均已有，docs 220 篇）。

**v1 遗漏的三项真实问题**（本版新增，且是最高 ROI）：无 CI、无 lint/prettier 配置、无覆盖率度量。

---

**审阅完成**：2026-08-11
**方法说明**：本版所有论断均附命令实证或 `file:line`；未验证的判断标注"推测"。
