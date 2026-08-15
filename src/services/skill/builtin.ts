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
| <项目根>/.mcp.json | 项目级 MCP | 团队共享可进 git；首用时弹批准（指纹存 ~/.ecode/approved-mcp.json） |
| .env | 仅开发模式 | npm run dev 时读；发布版（ecode 命令）不读 |
| ~/.ecode/skills/ | 用户级 skill | 目录名=skill 名，内放 SKILL.md |
| <项目根>/.ecode/skills/ | 项目级 skill | 同名覆盖用户级 |

优先级：进程环境变量 > .env（dev）> config.json。密钥优先环境变量 ANTHROPIC_API_KEY，其次 config 的 apiKey。

## config.json 字段速览

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| default | {provider, model} | — | 启动选中的供应商+模型 |
| providers | Record<名, ProviderCfg> | — | 供应商配置，key 为自定义名 |
| mcpServers | Record<名, McpServerConfig> | — | MCP 外部工具（见下节） |
| maxIterations | number | 50 | Agent 循环最大轮数 |
| bashMaxOutputBytes | number | 30720 | bash 输出截断阈值（头尾中截） |
| logLevel | string | info | debug / info / warn / error |

providers.<名> 字段：

~~~jsonc
{
  "type": "anthropic",              // 协议：anthropic | openai（必填）
  "baseURL": "https://...",         // 端点（必填）
  "apiKey": "",                     // 密钥（必填；环境变量优先）
  "models": ["glm-5.2"],            // 可用模型（/model 列这些）
  "thinking": "medium",             // off | low | medium | high
  "maxTokens": 8192,                // 单次最大输出 token
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

## 常见任务配方

### 加一个 MCP server
1. 编辑 ~/.ecode/config.json 的 mcpServers（或项目根 .mcp.json）
2. 重启 ECode → /mcp 确认状态 → 对话中使用对应工具（首次弹确认）

### 调整思考强度
改 providers.<名>.thinking（off/low/medium/high）后重启。/model 运行时只切模型不切 thinking。

### 加第二家供应商
providers 下新增 key（type/baseURL/apiKey/models）→ 重启 → /model 切换。/setup 向导可代配（增量编辑不洗掉其他字段，写前自动备份 .bak）。

## 运维事实

- config 不热加载：改完重启生效（/model、/setup 例外，运行时生效）
- 配置解析失败：启动报 [CONFIG_PARSE_FAILED] 并拒绝启动，**绝不覆盖写坏的文件**——手动修复，或删除后重启重新生成模板
- 日志：~/.ecode/logs/<sessionId>.jsonl（logLevel 控制）；会话历史：~/.ecode/sessions/
- 修改配置保持 JSONC 合法（注释允许）；改前可备份 .bak，改后用 read_file 复查再重启`

export function builtinSkillInfos(): SkillInfo[] {
  return [
    {
      name: ECODE_CONFIG_SKILL_NAME,
      description:
        'ECode 自身配置权威手册：config.json 字段速览、MCP server 配置（stdio/http）、provider/thinking/采样参数、常见任务配方与运维事实。用户想修改或询问 ECode 的配置与用法时加载，不要凭记忆猜配置格式。',
      whenToUse:
        '用户提到 ~/.ecode/config.json、mcpServers、.mcp.json、provider 配置、thinking/采样参数、/setup，或问「ECode 怎么配置/怎么用」时',
      body: ECODE_CONFIG_BODY,
      baseDir: '',
      source: 'builtin',
      userInvocable: true,
      disableModelInvocation: false,
    },
  ]
}
