/**
 * 内置 skill（M6.5）：随 ECode 发布、不经文件系统——load() 时注入注册表。
 *
 * ecode-config：自身配置手册（对齐 claude-code update-config / opencode customize-opencode
 * 的「嵌入式手册」模式——模型对配置格式的直觉常常是错的，给它真 schema 而非猜测）。
 * source='builtin' 优先级最低：用户/项目/插件同名 skill 覆盖（用户能自定义手册）。
 * baseDir=''：无附属文件目录（SkillTool 对空 baseDir 不输出目录行）。
 */

import type { SkillInfo } from '../skill.js'

/** 内置手册 skill 名（system.ts 路由行同用——单一事实源防改名漂移，审阅 P2-3）。 */
export const ECODE_CONFIG_SKILL_NAME = 'ecode-config'

/** 手册正文。⚠ 模板字符串内：围栏用 ~~~（避开反引号）、\${} 转义（避开插值）。 */
const ECODE_CONFIG_BODY = `# ECode 配置手册

ECode 自身的权威配置指南。修改配置前先读本手册；不确定时先用 read_file 读用户当前配置文件再改，不要凭记忆猜测字段。

## 配置文件位置与优先级

| 文件 | 作用域 | 说明 |
|---|---|---|
| ~/.ecode/config.json | 用户级主配置 | JSONC（允许注释）；providers / mcpServers / 全局参数 |
| ~/.ecode/settings.json | 用户级权限 | permissions 规则（见「权限规则」节） |
| <项目根>/.ecode/settings.json | 项目级权限 | 同上；进 git 团队共享 |
| <项目根>/.ecode/settings.local.json | local 权限 | 弹窗「永久记住」的落点；gitignore 不污染团队 |
| <项目根>/.mcp.json | 项目级 MCP | 团队共享可进 git；首用时弹批准（指纹存 ~/.ecode/approved-mcp.json） |
| .env | cwd 级环境变量 | dev 与 serve 都读**启动目录**的 .env；值不进 process.env（防密钥泄漏）；ECODE_SERVE_*/ECODE_BASE_URL 等均支持 |
| ~/.ecode/skills/ | 用户级 skill | 目录名=skill 名，内放 SKILL.md |
| <项目根>/.ecode/skills/ | 项目级 skill | 同名覆盖用户级 |

优先级：进程环境变量 > .env（cwd）> config.json。密钥优先环境变量 ANTHROPIC_API_KEY，其次 config 的 apiKey。

## config.json 字段速览

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| default | {provider, model} | — | 启动选中的供应商+模型 |
| providers | Record<名, ProviderCfg> | — | 供应商配置，key 为自定义名 |
| mcpServers | Record<名, McpServerConfig> | — | MCP 外部工具（见下节） |
| maxIterations | number | 50 | Agent 循环最大轮数 |
| subagentMaxIterations | number | 跟 maxIterations | 子代理（task 工具）迭代上限；缺省=跟主代理 maxIterations |
| bashMaxOutputBytes | number | 50000 | bash 输出截断阈值（50KB 头尾中截；超限落盘 sessions/<sid>.outputs/ 可回看） |
| logLevel | string | "info" | 日志级别：debug/info/warn/error |
| hooks | HookSpec[] | — | 事件 hook（M7）：SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd；command 子进程，stdin 喂事件 JSON，stdout 可回 {continue:false} 阻断 / updatedInput 改参 / additionalContext 附加；exit 2 = 阻断 |
| maxInstructionsKB | number | 32 | 指令/记忆注入单级上限 KB（ECODE.md/CLAUDE.md/MEMORY.md 各级） |
| webFetchMaxKB | number | 30 | web_fetch 回喂内容上限 KB |
| providers.*.pricing | Record<模型, {input,output,cacheRead?,cacheWrite?}> | — | 定价覆盖（¥/Mtok，优先于内置表与 models.dev 同步值） |
| plugins | Record<"name@market", boolean> | — | 插件启用状态（/plugin 面板维护） |
| sandbox | {defaultMode?, blockedCommands?} | 关 | 沙箱（M9）：defaultMode = default/accept-edits/read-only/workspace-write/full-access 五档（Tab 键或 /sandbox 面板切换；accept-edits=纯编辑类免审批直放、bash 等仍走审批）；blockedCommands 通配黑名单全档硬拒 |
| lintCommand / testCommand | string | 关 | 编辑后自动验证（M9）：**空串/缺省=关闭，不会自动探测**；显式命令优先。失败输出回喂模型自纠，连续失败熔断 |
| autoCommit | boolean | false | git 轻量集成（M9）：轮末有编辑且 lint/test 绿自动 commit（带 Ecode-Commit trailer，只提交本轮文件；/undo 只退 ECode 提交） |
| maxTokens（providers.*） | number | 32768 | 单次最大输出 token——8192 配 thinking（budget 占额）极易触顶截断（表现：回复半截后静默，12s 后告警行消失；/warnings 可查） |
| notificationIdleSeconds | number | 60 | 审批/等待输入持续 N 秒触发通知（0=关，批2d） |
| bellOnApproval | boolean | true | 审批卡首次出现响终端 BEL（批2d） |
| sessionIdleMinutes | number | 120 | serve 会话空闲回收分钟（0=不收；M13 serve 场景） |
| approvalTimeoutMs | number | 3600000 | 审批挂起超时 ms（0=不限；D-T8 默认 1h，超时如实告知模型「无人应答」并引导其决策/记录待办） |
| feishu | {appId, appSecret, allowUsers?} | — | 飞书 IM 网关（M13）：配了凭据 serve 自动激活，长连接免公网；allowUsers=open_id 白名单，**缺省/空=拒绝所有** |
| webSearch | {provider?, apiKey?, engine?, preferMcp?} | bing | 联网搜索（M10）：bing RSS 免费；可切 zhipu（配 apiKey/engine）；preferMcp 声明搜索 MCP server 名 |
| roles | {summary?: {provider, model}} | — | 角色分流（M13）：summary=压缩摘要专用便宜模型；provider 名必须存在于 providers |

providers.<名> 字段：

~~~jsonc
{
  "type": "anthropic",              // 协议：anthropic | openai（必填）
  "baseURL": "https://...",         // 端点（必填）
  "apiKey": "",                     // 密钥（必填；环境变量优先）
  "models": ["glm-5.2"],            // 可用模型（/model 列这些）
  "thinking": "medium",             // off | low | medium | high
  "maxTokens": 32768,               // 单次最大输出 token（8192 配 thinking 极易触顶截断）
  "contextWindow": 200000,          // 可选；上下文窗口覆盖（escape hatch，缺省 models.dev 自动探测）
  "streamStallMs": 90000,           // 可选；流停滞看门狗 ms（缺省 90000，0=关闭；非流式 thinking 端点调大）
  "temperature": 0.7,               // 可选；anthropic 协议 thinking 非 off 时禁用（否则 400）
  "topP": 0.95                      // 可选；同上
}
~~~

thinking 注意：anthropic 协议映射为 budget_tokens（low=2048 / medium=8192 / high=16384），此时不能传 temperature/top_p；openai 协议映射为 reasoning_effort，OpenAI 非推理模型对未知参数可能 400（此时设 off）。

## mcpServers 配置

~~~jsonc
"mcpServers": {
  "filesystem": {                        // 名字自定义；工具名 = mcp__名字__工具名
    "type": "stdio",                     // stdio（本地子进程）| http（远程）
    "command": "npx",                    // stdio 必填
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "lifecycle": "lazy",                 // lazy（默认，首次调用才连）| eager | keep-alive | lazy-keep-alive
    "idleTimeout": 10,                   // 空闲 N 分钟断开（lazy 默认 10；keep-alive 系默认 0=不断）
    "timeout": 30000,                    // 单次调用超时 ms（默认 30000）
    "env": { "TOKEN": "\${MY_TOKEN}" },  // 子进程环境变量；\${VAR} 从当前环境展开，缺变量则跳过该 server
    "enabled": true                      // false=禁用（不注册工具）
  },
  "my-http": {
    "type": "http",                      // http 必填 url
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer \${MY_KEY}" }
  }
}
~~~

行为要点：改完重启生效；工具清单缓存在 ~/.ecode/mcp-cache.json；每个 MCP 工具首次执行会弹确认（可选「本会话记住」server 级放行）；/mcp 面板查看状态/重连/断开。项目级 .mcp.json 格式相同，外层为 {"mcpServers": {...}}，首用时需批准（防克隆恶意仓库静默 spawn）。secret 一律用 \${ENV_VAR} 占位符，不落明文。

## 权限规则（settings 三层，M9）

管控扩展源（skill/plugin）hook 的执行；用户自己在 config.json 配的 hooks 不问。

~~~jsonc
// <项目根>/.ecode/settings.local.json（或 ~/.ecode/settings.json 用户级）
{
  "permissions": {
    "allow": ["Hook(skill:*)"],        // 通配：括号内尾 * 前缀匹配
    "ask":   ["Hook(plugin:other@npm)"],
    "deny":  ["Hook(plugin:evil@mkt)"]
  }
}
~~~

- 三态 allow / ask / deny；无规则默认 ask（每次弹窗问）
- 求值：deny 任一层终局 > local > project > user 首个命中
- 手改即生效（每次求值现读文件，不用重启）；写坏 JSON 该层静默按无规则处理（表现为又开始弹询问，/doctor 第 8 项可查出）
- 弹窗第三键「永久记住」= 写入 local 层 settings.local.json
- 目前仅 Hook(owner) 一维；Skill/Plugin/Mcp 维度与 /permissions 面板后置

## review 任务纠偏审查

主模型跑常规轮，高级 reviewer 模型「定时兜底 + 异常信号提前触发」出纠偏卡注入（只审查不接管——不改变任务执行流）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | boolean | 必填 | true 开启；false/不配 review 节=零行为变化 |
| provider | string | 必填 | 高级模型所在供应商名——**enabled=true 时启动期校验**：必须存在于 providers（CONFIG_REVIEW_INVALID） |
| model | string | 必填 | 审查用模型（enabled=true 时校验非空） |
| intervalTurns | number | 5 | 定时兜底：每 N 个用户轮审查一次 |
| minTurns | number | 3 | 长任务才启动：前 N 轮不触发（短任务不值得审查烧钱） |
| onSignals | boolean | true | 异常信号提前触发：连续工具失败/单轮迭代过长（每轮最多一次，防连环审查） |

- 隐私提示：启用后**近期对话（含工具输出）会发送至 review.provider 所配端点**——与主模型不同厂商时即数据多流向一个端点，自行权衡
- 费用可见性：审查调用在 /stats 按模型可见
- 等级定义即此处的 provider/model（谁强谁弱用户显式配置，代码只管调度）

## relay 中继接入（异地手机）

出站连接：

~~~jsonc
"relay": { "server": "wss://<relay源>", "hostToken": "<REG_TOKEN>", "hostId": "登记名", "name": "别名" }
~~~

——server 与 hostToken 必填才激活（缺省不连）；hostId 多机区分（缺省主机名），name 是手机端显示别名。配了后 serve 自动连中继，纯出站零新增入站端口。

三条远程接入路径选择：
| 路径 | 适用 | 配置 |
|---|---|---|
| serve + 同 WiFi | 局域网直接访问 | ECODE_SERVE_HOST/PASSWORD（.env），免额外服务 |
| feishu / wechat | 走 IM 通道免公网 | 各自节凭据，长连接 |
| relay | 异地（手机不在同一网络） | 自部署 relay 源 + hostToken（见 docs/规范/2026-09-01_ECode-relay自部署指南） |

## wechat 微信接入（ClawBot）

~~~jsonc
"wechat": { "botToken": "<token>", "allowUsers": ["<id>@im.wechat"] }
~~~

botToken 经 "ecode wechat-login" 命令扫码获取；allowUsers 是 user id 白名单，**缺省/空=拒绝所有消息**（安全默认，必配白名单才可用）。

## 常见任务配方

### 加一个 MCP server
1. 编辑 ~/.ecode/config.json 的 mcpServers（或项目根 .mcp.json）
2. 重启 ECode → /mcp 确认状态 → 对话中使用对应工具（首次弹确认）

### 调整思考强度
改 providers.<名>.thinking（off/low/medium/high）后重启。/model 运行时只切模型不切 thinking。

### 加第二家供应商
providers 下新增 key（type/baseURL/apiKey/models）→ 重启 → /model 切换。/setup 向导可代配（增量编辑不洗掉其他字段，写前自动备份 .bak）。

### 手机上看 ECode（serve 常驻）
1. 构建 web 前端（仓库内：cd web && npm ci && npm run build；发布包自带 web/dist 免此步）
2. 项目根 .env 写 ECODE_SERVE_HOST=0.0.0.0 + ECODE_SERVER_PASSWORD=<强密码>（非 loopback 必须密码，否则拒绝启动）；可选 ECODE_SERVE_PORT（默认随机）
3. ecode serve 启动 → 打印 Mobile: http://<局域网IP>:<port> → 手机同 WiFi 浏览器打开输密码
4. ecode serve stop 停止。外网访问不内置穿透——用 Tailscale。或配 feishu 节走飞书 IM（免公网免同 WiFi）

## 运维事实

- config 不热加载：改完重启生效（/model、/setup 例外，运行时生效）
- 配置解析失败：启动报 [CONFIG_PARSE_FAILED] 并拒绝启动，**绝不覆盖写坏的文件**——手动修复，或删除后重启重新生成模板
- 日志：<项目根>/.ecode/logs/<sessionId>.jsonl（cwd 级——serve 形态 serve-<sessionId>.jsonl；logLevel 控制）；会话历史：~/.ecode/sessions/
- 修改配置保持 JSONC 合法（注释允许）；改前可备份 .bak，改后用 read_file 复查再重启
- 「响应停滞 90000ms」告警（STREAM_STALL）：端点连续 90s 不吐字，看门狗中止。零产出会自动重试 1 次；已有部分产出时 provider 自动**续写**（半截固化为前缀继续补尾部，最多 2 次；含工具调用/思考的半截不续写直接报错——参数截断无法安全补齐）。若仍失败：让 agent 分批写入（先骨架后逐节追加），不要原样重发整轮`

export function builtinSkillInfos(): SkillInfo[] {
  return [
    {
      name: ECODE_CONFIG_SKILL_NAME,
      description:
        'ECode 自身配置权威手册：config.json 字段速览、MCP server 配置（stdio/http）、权限规则（settings 三层 allow/ask/deny）、provider/thinking/采样参数、常见任务配方与运维事实。用户想修改或询问 ECode 的配置与用法时加载，不要凭记忆猜配置格式。',
      whenToUse:
        '用户提到 ~/.ecode/config.json、mcpServers、.mcp.json、settings.json/settings.local.json、权限规则（permissions/allow/deny）、provider 配置、thinking/采样参数、/setup，或问「ECode 怎么配置/怎么用」时',
      body: ECODE_CONFIG_BODY,
      baseDir: '',
      source: 'builtin',
      userInvocable: true,
      disableModelInvocation: false,
    },
  ]
}
