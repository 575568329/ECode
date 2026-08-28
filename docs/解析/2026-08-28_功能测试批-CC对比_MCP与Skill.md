# 功能测试批：CC 对比——MCP 配置面与 Skill 双触发

> 状态：已完成 · 日期：2026-08-28 · 来源：功能测试批任务书 D 项
> 对照对象：`D:\study\claude-code-main`（CC 反编译还原 TS 源码，下称 CC，行号为该仓库实际行）vs ECode（本仓库 src/）。
> 方法承诺：每个机制断言先读源码再落笔，均附 file:line 锚点。

## 维度一：MCP 配置面对比

### CC 侧机制（源码锚点）

**三个作用域 + 合并顺序**：

- `local` → `~/.claude.json` 内 `projects[<git-root或cwd>].mcpServers`（`src/utils/config.ts:1602-1614`，key 由 `getProjectPathForConfig()` 归一化为 git root 或 cwd）
- `project` → 项目根 `.mcp.json`（`src/services/mcp/config.ts:852-859`）；且**父目录向上遍历**，越靠近 cwd 优先（`config.ts:916-933` 注释 "Process from root downward to CWD (so closer files have higher priority)"）
- `user`（system）→ `~/.claude.json` 顶层 `mcpServers`（`config.ts:692-704` `saveGlobalConfig`）
- 另有 `enterprise`（managed-mcp.json，存在时独占）、`dynamic`（`--mcp-config`）、claude.ai connector、插件命名空间等扩展作用域

合并优先级（`src/services/mcp/config.ts` getClaudeCodeMcpConfigs 末段）：

```ts
// Merge in order of precedence: plugin < user < project < local
const configs = Object.assign({}, dedupedPluginServers,
  userServers, approvedProjectServers, localServers)
```

**`claude mcp` 命令面**（`src/main.tsx` commander 注册，约 3910-3953；参数定义 `src/commands/mcp/addCommand.ts:29-78`）：

- `mcp add <name> <commandOrUrl> [args...]`，`-s/--scope`（local/user/project，**默认 local**）、`-t/--transport`（stdio/sse/http）、`-e/--env`、`-H/--header`、OAuth 参数
- 配套 `mcp list / get / remove / serve / add-json / add-from-claude-desktop / reset-project-choices`
- 写 project 作用域用原子写（`writeMcpjsonFile`，`config.ts:84-152`）；受企业 allowlist/denylist 约束

**项目级首用批准门**：

- 状态判定 `getProjectMcpServerStatus()`（`src/services/mcp/utils.ts:351-395`）→ `approved|rejected|pending`：`enabledMcpjsonServers` 命中或 `enableAllProjectMcpServers=true` → approved；`disabledMcpjsonServers` → rejected；否则 pending。非交互模式**不会**自动批准（注释明确防 repo 通过项目 settings 伪造批准）
- 批准 UI：`src/components/MCPServerApprovalDialog.tsx`（单个）/ `MCPServerMultiselectDialog.tsx`（多个），选项 yes_all/yes/no；批准结果写入 **localSettings**（`.claude/settings.local.json`）的 `enabledMcpjsonServers` 等字段（ApprovalDialog.tsx:29-37 附近）；旧 `~/.claude.json` 字段有迁移（`src/migrations/migrateEnableAllProjectMcpServersToSettings.ts`）
- 仅 approved 的 project server 进入合并（getClaudeCodeMcpConfigs 内过滤）

**生命周期**：交互模式 trust 对话框后 `prefetchAllMcpResources`；MCP 连接**不阻塞** REPL/首回合（main.tsx 注释 "MCP never blocks REPL render OR turn 1 TTFT...Slow servers populate for turn 2+"）；远端 transport 断线自动重连（指数退避 5 次，`src/services/mcp/useManageMCPConnections.ts`）；`/mcp` 面板（`src/commands/mcp/index.ts`，`[enable|disable [server-name]]`）查看状态/能力/启停/重连。

### ECode 侧机制（本仓库锚点）

- **用户级** `config.json` 的 `mcpServers` + **项目级** `<cwd>/.mcp.json` 两作用域（`src/services/mcp/config.ts:6,41-120`）；secret 一律 `${ENV_VAR}` 占位符
- **lifecycle 四态** lazy/eager/keep-alive/lazy-keep-alive（`src/services/mcp/config.ts:25`；连接与空闲策略 `src/services/mcp/manager.ts:61,167-207`）——CC 无此显式枚举，靠「启动即连 + 断线重连」隐式覆盖
- **首用批准**：项目级 .mcp.json 整文件 hash 持久化到 `~/.ecode/approved-mcp.json`，批准后不再问（`src/services/mcp/config.ts:131-163`）；遍历边界做了 home 停止/跨盘收在 git 根的防逃逸（`config.ts:89-120`）
- `/mcp` 面板：状态/重连/断开（M6 面板 TUI v5）
- MCP 工具首次执行另有逐工具确认（server 级「本会话记住」放行）

### 结论：缺什么 / 多什么 / 取舍

| | ECode 缺（CC 有） | ECode 多 / 强（CC 无） |
|---|---|---|
| MCP | ① `local` 第三作用域（per-project 私有 server 存用户文件）；② `claude mcp add` CLI 命令面（ECode 只能手改 config/面板）；③ enterprise managed 作用域与 allowlist/denylist 策略；④ 向上遍历父目录 .mcp.json（ECode 只认 cwd，见下「取舍」）；⑤ 远端 transport 断线自动重连退避 | ① lifecycle 四态显式枚举（lazy 默认 + 空闲卸载 + failed 60s 退避，省资源可预期）；② 逐 server 细粒度 approved/rejected，ECode 用**整文件 hash** 批准（更粗但更简单——文件任何改动都会重新触发批准，反而是安全增益） |

**设计取舍**：CC 的父目录遍历 + local 作用域服务于「monorepo 多级配置」场景；ECode 砍掉遍历、只认 cwd+git 根边界，换来心智简单与防「盘根 .mcp.json 批准一次全盘生效」类攻击面（`config.ts:91` 注释明说）。ECode 缺 CLI 命令面是 MVP 阶段性缺口（有 /mcp 面板 + config.json 覆盖高频操作），值得排期补。CC 不阻塞 TTFT 的异步连接策略 ECode 的 lazy 已天然等价甚至更激进（首调用才连）。

## 维度二：Skill 双触发对比

### CC 侧机制（源码锚点）

**模型自动触发**：工具名 `SKILL_TOOL_NAME`（`src/tools/SkillTool/constants.js`；实现 `SkillTool.ts:281`），入参 `{skill, args?}`（`SkillTool.ts:242-249`）。触发规则在工具 prompt（`src/tools/SkillTool/prompt.ts:185-197`）：用户请求匹配 skill 时是 **BLOCKING REQUIREMENT**、禁止只提不调。**没有代码级关键词匹配**——匹配全靠模型基于注入清单（name+description，含 when_to_use）自行判断。

**清单注入**：**不在 system prompt**，而是 `skill_listing` attachment 作为 `<system-reminder>` 包裹的 meta user message 注入对话（`src/utils/attachments.ts:875,2661`；渲染 `src/utils/messages.ts:3728` 附近）；每 agent 增量下发、总预算约上下文 1%、单条描述 ≤250 字符（`prompt.ts:18,28`）。

**手动触发**：`/skill-name args` 由 `processSlashCommand` 解析（`src/utils/processUserInput/processSlashCommand.tsx`）。**分流靠两个 frontmatter 布尔**：`user-invocable: false` 时斜杠路拒绝（processSlashCommand.tsx："This skill can only be invoked by Claude"）；`disable-model-invocation: true` 时清单排除且 SkillTool 拒绝（`SkillTool.ts:412`；清单过滤 `src/commands.ts:555,563-569`）。两路汇合到同一展开函数 `getMessagesForPromptSlashCommand`。

**发现**：用户级 `~/.claude/skills`、项目级 `.claude/skills`（`src/skills/loadSkillsDir.ts:625,83`），仅目录形式 `name/SKILL.md`（`loadSkillsDir.ts:424,431`）；frontmatter 含 allowed-tools、context: fork、paths 条件激活等丰富字段（`loadSkillsDir.ts:152-260`）。

**注入方式**：skill 正文作为 **isMeta user message** 注入并触发 query，tool_result 只写 "Launching skill"（`SkillTool.ts:612,742,800` 附近）；`context: fork` 例外——隔离子代理执行、结果以 tool_result 返回（`SkillTool.ts:98`）。

### ECode 侧机制（本仓库锚点）

- **清单注入 system prompt 尾部**：`<available_skills>` XML 块，每条 `<name>+<description>`（`src/services/skill/listing.ts:42-69`）；同样有 1% 上下文预算与「预算不足仅列名」降级（`listing.ts:15,69`）——与 CC 的 1%（CC prompt.ts:18）殊途同归，差异在挂载点：CC 是对话内 system-reminder，ECode 是 system prompt 段
- **模型面**：skill 工具模型自主调用（本次实测即证）
- **手动面**：`/skill` 打开 SkillPanel 手动选用（`src/commands/registry.ts:145-147` → action 'skill-panel'），非斜杠直呼 skill 名——S4.4 分流：面板浏览/选用与模型自动触发分离
- **发现**：`~/.ecode/skills/`（用户级）+ `<项目根>/.ecode/skills/`（项目级，同名覆盖）（`src/services/skill/builtin.ts:30-31`）；SKILL.md 格式兼容（目录名=skill 名）；有 `userInvocable` 字段雏形（`builtin.ts:146`）
- ECode 另有 CC 没有的 **蒸馏链**（`src/services/skill/distill.ts`：会话中沉淀 skill 候选）

### 结论

1. **触发匹配机制本质相同**：两边都是「注入 name+description 清单 + 模型自主判断 + 工具调用」，均无代码级匹配器。CC 的规则措辞更硬（BLOCKING REQUIREMENT、禁空头提及），ECode 的系统提示措辞相对温和（「任务匹配时调用，即使没被点名」），可考虑借鉴 CC 的硬约束措辞提升触发率。
2. **手动触发面形态不同**：CC `/skill-name` 直呼式（skill=斜杠命令一体）；ECode `/skill` 面板式（多一步交互，但可浏览/搜索/创建）。这是 CLI 血统 vs 面板优先的取舍，非能力缺失；但 ECode 若要吃 CC 生态的 skill 库（frontmatter 指望 `/name` 直呼），补斜杠直呼解析成本低收益高。
3. **分流开关**：CC 双布尔（user-invocable / disable-model-invocation）已闭环；ECode 有 userInvocable 字段但（本次抽查）未见对称的 disable-model-invocation，属缺口。
4. **注入挂载点**：CC 用对话内 system-reminder（可增量、随上下文演化、压缩后可恢复 invoked_skills），ECode 用 system prompt 固定段（简单，但清单大时占固定预算且无增量机制）。当前 skill 规模下无感，长期可参考 CC 的 attachment 化。
5. **ECode 独有优势**：L0/L1/L2 三层渐进加载（M6）与蒸馏创建链（distill.ts）是 CC 没有的自动沉淀闭环。

---
*本文为功能测试批 D 项产出；A/B/C 项实测结果见批任务汇报（会话内），未另存档。*
