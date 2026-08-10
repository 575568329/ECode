# ECode 自举清单

> 自举（self-bootstrap）= **用 ECode 自己的能力改进 ECode 自己**。
> 本文档梳理项目中"可以立即动手做"的改进项，按 ROI 排序。
> 更新日期：2026-08-10

---

## 一、配置与文档（5 分钟内，零风险）

### 1.1 `npm test` 改 `vitest run`

**现状**：`package.json` 的 `"test": "vitest"` 是 watch 模式，CI / 脚本里跑会永久挂死（debugging #016）。

**改法**：
```json
"test": "vitest run",
"test:watch": "vitest"
```

### 1.2 CHANGELOG 补本次会话改动

**现状**：CHANGELOG 停在 v0.2.0 unreleased，缺少以下 commit：

- MCP 子进程泄漏修复（shutdown 统一清理，debugging #019）
- callTool 超时保护（60s，之前裸调无超时）
- ToolFailureTracker 公共组件（工具连续失败检测）
- MAX_ITERATIONS 可配置 + 达上限诚实总结
- 多模态图片输入三级降级（vision-fallback）
- MCP 工具结果单行 JSON 美化

### 1.3 README 修 v0.2.0 占位

**现状**：README 写 "全局安装（v0.2.0 发布后）"，但 M1-M6 功能已全部落地。

**改法**：更新特性列表（补 Skills / 模型路由 / 预算感知 / 图片降级）、安装说明。

### 1.4 `.env.example` 更新

**现状**：停在 M2，没提 `agent.maxIterations` / `vision` 能力 / MCP 配置。

### 1.5 config 注释头补 agent 块

**现状**：已补 `agent.maxIterations`（本次会话），但 `vision` 能力声明方式没示例。

---

## 二、工程质量（30 分钟 ~ 2 小时）

### 2.1 修复 2 个 flaky 测试

| 测试 | 问题 | 修法 |
|------|------|------|
| `subagent-integration.test.ts` | 5s 超时（递归 runAgentStream 耗时） | 加 `testTimeout: 30000` |
| `repl-human.test.tsx` | process.exit 相关（双击 Ctrl+C / /exit） | mock `shutdown` 替代 `process.exit` |

### 2.2 GitHub Actions CI

**现状**：无 CI。全量测试靠手动 `vitest run`。

**方案**：一个 `.github/workflows/ci.yml`：
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build
      - run: npx vitest run
```

### 2.3 CONTRIBUTING.md

**现状**：不存在。CLAUDE.md 里已有大量开发规范，可提取为贡献指南。

**内容**：项目结构 / ESM 约定 / tsconfig strict / 测试约定 / commit 格式 / 文档管理流程。

---

## 三、自举验证——用 ECode 跑 ECode

### 3.1 编译后实跑

**现状**：从未编译后 `node dist/index.js` 实跑过（一直用 `npm run dev` = tsx 热编译）。

**验证步骤**：
```bash
npm run build
node dist/index.js "给 src/image.ts 的 detectImageType 函数补充单元测试"
```

**意义**：验证 `files` 白名单、`bin` 入口、dist 产物完整性。

### 3.2 config 声明 vision 模型

**现状**：GLM-5.2 没有 `vision` capability，用户附图片时永远走 strip 降级。

**改法**：在 `~/.ecode/config.json` 的 glm provider 下加：
```jsonc
"glm-4v-plus": { "capabilities": ["tools", "vision"], "contextWindow": 16000 }
```

然后 `node dist/index.js --model glm-4v-plus "分析这张图片 xxx.png"` 验证 inline 策略。

### 3.3 端到端冒烟清单

以下场景从未在编译产物上验证过：

- [ ] `/sessions` 列表 + `/resume` 续接
- [ ] `/compact` 手动压缩
- [ ] Ctrl+C 中断 + 撤回回填
- [ ] Shift+Enter 多行输入
- [ ] MCP server 连接 + `/mcp` 管理
- [ ] `/model` 切换模型
- [ ] 权限审批弹窗（三态）
- [ ] 子代理 Task 工具
- [ ] 图片输入 + 降级 warning

---

## 四、后续扩展（M6 阶段 E/F）

### 4.1 多渠道服务化（阶段 E）

前后端分离：ECode 核心 → 本地 HTTP+WS 服务 → Web 前端 / IM Bot。

前置已核实：CLAUDE.md §4.2 的 React 全栈是残留模板（react ^19 仅 ink peer dep），Web 前端需从零引入。

### 4.2 体验打磨（阶段 F）

- 并行只读工具（grep / glob 并发）
- usage 细化 UI（per-round token 明细）
- Repo Map 接入点预留（独立可选包）

### 4.3 真机冒烟 4 项（M3.5 遗留）

- Ctrl+O pager
- bash 跨平台（Git Bash 探测）
- 消息不重复
- 多行 Shift+Enter（Windows Terminal）

---

## 优先级建议

1. **先做 1.1~1.4**（文档/配置，10 分钟，零风险）
2. **再做 3.1**（编译后实跑，验证交付物完整性）
3. **然后做 2.1**（修 flaky 测试，让 CI 可靠）
4. **最后做 2.2**（CI，自动化保障）
