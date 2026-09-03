/**
 * Config 完整版（M4 P0-1）。
 *
 * 详设 §4 + M4 §4。providers map + current + per-provider 采样参数。
 * 优先级（高→低）：进程环境变量（含 .env 加载，dev 内部机制）> config 文件 > 默认值。
 *
 * 数据分层（D12）：config.json 用户级（~/.ecode/），重要数据防误删。
 * 配置有效性判断（D10）：不看「首次运行」，只看能否拿到有效 provider
 *   （apiKey+baseURL+model 齐）。无效 → cli 进 REPL + banner 提示 /setup。
 */

import { SANDBOX_MODES, type SandboxMode } from './sandbox.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse as parseJsonc, modify, applyEdits, type FormattingOptions } from 'jsonc-parser'
import dotenv from 'dotenv'
import type { ProviderReq, ThinkingLevel } from '../providers/interface.js'
import { DEFAULT_MAX_TOKENS } from '../core/types.js'

/** 单个供应商配置（export：buildProviderReq / Wizard / /model 都要用） */
export interface ProviderCfg {
  type: 'anthropic' | 'openai'
  baseURL: string
  apiKey: string
  models: string[]
  temperature?: number
  topP?: number
  maxTokens?: number
  thinking?: ThinkingLevel
  /** 上下文窗口覆盖（escape hatch；不配则 models.dev 自动探测，M5 §5） */
  contextWindow?: number  /** 定价覆盖（M8 债 #6）：{ "<model>": { input, output, cacheRead?, cacheWrite? } }，¥/Mtok——优先于内置表与 models.dev 同步值 */
  pricing?: Record<string, import('./pricing.js').ModelPricing>
  /** 流停滞看门狗毫秒（P0-B：缺省 90000；0=关闭——语义见 providers/interface.ts ProviderReq.streamStallMs） */
  streamStallMs?: number

}

export interface Config {
  providers: Record<string, ProviderCfg> // 多 provider map
  current: { name: string; model: string } // 当前激活（/model 改这个）
  maxIterations: number
  /** 2026-09-03 拍板：子代理迭代上限（undefined=跟主代理 maxIterations——消费侧 `?? maxIterations`） */
  subagentMaxIterations?: number
  bashMaxOutputBytes: number
  /** M9-P3：编辑后自动 lint/test（仅认显式配置；undefined/''=关闭，不自动探测——安全默认） */
  lintCommand?: string
  testCommand?: string
  /** M9-P4：沙箱（defaultMode 缺省 default=现状=关；blockedCommands 全档硬拒） */
  sandbox?: { defaultMode?: SandboxMode; blockedCommands?: string[] }
  /** M9-P6：编辑轮末自动 git commit（默认 false——不静默改用户 repo；/undo 只退 ECode 提交） */
  autoCommit?: boolean
  /** M13-W2：会话空闲回收阈值分钟（serve 多会话；默认 120；0=不收——项目基座常驻不收，仅收闲置会话） */
  sessionIdleMinutes?: number
  /** M13-B2：审批挂起超时毫秒（默认 15 分钟；0=不限——超时自动 reject + resolved('timeout') 轨迹） */
  approvalTimeoutMs?: number
  /** 批2d（§13.1 拍板-1）：Notification hook 触发阈值秒——审批挂起/空闲等待用户输入持续 N 秒触发；
   *  0=关闭（对齐 CC idle 通知语义，默认 60） */
  notificationIdleSeconds?: number
  /** 批2d（§13.1 拍板-1 附）：TUI 审批卡首次出现时响一次 BEL 终端铃（默认 true，可关） */
  bellOnApproval?: boolean
  /**
   * M13-B3 角色分流：summary=压缩摘要专用（便宜 flash 模型干力气活）。
   * 不配 = 会话主模型（现状零行为变化）；窗口下限校验从批预算常量反算（装配层执行）。
   */
  roles?: { summary?: { provider: string; model: string } }
  /**
   * 任务纠偏审查（2026-09-02 用户拍板）：低级主模型跑常规轮，高级 reviewer 模型
   * 「定时兜底 + 异常信号提前触发」出纠偏卡注入（只审查不接管——KV cache 与执行连续性不破）。
   * 等级定义即此处的 provider/model（谁强谁弱用户显式配置，代码只管调度）；
   * enabled=false / 不配 = 零行为变化。
   */
  review?: {
    enabled: boolean
    /** 高级模型（等级定义）：provider 名必须存在于 providers（loadConfig 校验） */
    provider: string
    model: string
    /** 定时兜底：每 N 个用户轮触发一次（默认 5） */
    intervalTurns?: number
    /** 长任务才启动：前 N 轮不触发（默认 3——短任务不值得审查烧钱） */
    minTurns?: number
    /** 异常信号提前触发（默认 true）：连续工具失败 / 单轮迭代过长 */
    onSignals?: boolean
    /** 信号 gate 超时 ms（默认 60000）：signal 审查同步化——下一工具批前等审查，超时放行继续 */
    timeoutMs?: number
  }
  /** M13-W8 飞书 IM gateway（企业自建应用凭据——配了才激活；长连接免公网） */
  /** 飞书 IM gateway（企业自建应用凭据——配了才激活；长连接免公网）。
   *  allowUsers=open_id 白名单（审阅 P0-1：缺省/空=拒绝所有——p2p bot 整租户可见，
   *  无白名单即开放执行端点） */
  feishu?: { appId: string; appSecret: string; allowUsers?: string[] }
  /**
   * R2：relay 出站连接（异地手机接入——配了才激活；daemon 纯出站零入站新增）。
   * server=relay 源（wss://host）；hostToken=relay 的 REG_TOKEN（电脑段准入）；
   * hostId=本机登记名（多机区分，缺省主机名）。hostBase/phoneBase 仅本地直连 relay
   * 测试时覆盖 nginx 路径约定（缺省 server+/ecode-tunnel 与 server+/ecode）。
   */
  relay?: { server: string; hostToken: string; hostId?: string; name?: string; hostBase?: string; phoneBase?: string }
  /**
   * R4：微信 ClawBot gateway（iLink 协议——botToken 经 `ecode wechat-login` 扫码获取）。
   * allowUsers=user id 白名单（xxx@im.wechat）缺省拒——对齐 feishu 语义。
   */
  wechat?: { botToken: string; allowUsers?: string[] }
  /** M10-P1：联网搜索（provider 缺省 bing RSS 免费；preferMcp 显式声明搜索 MCP server 名；命中搜索 MCP 时内置不注册） */
  webSearch?: { provider?: 'bing' | 'zhipu'; apiKey?: string; engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark'; preferMcp?: string[] }
  /** 指令/记忆注入单级上限 KB（M8：ECODE.md/CLAUDE.md/MEMORY.md 各级截断阈值，默认 32） */
  maxInstructionsKB?: number
  /** web_fetch 回喂内容上限 KB（默认 30，头尾中截） */
  webFetchMaxKB?: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** MCP servers（M6；用户级配置，项目级 .mcp.json 在 mcp/config.ts 单独合并） */
  mcpServers?: Record<string, import('./mcp/config.js').McpServerConfig>
  /** hooks 原始声明（M7 H1 源 1；AJV 过滤在 hooks/validate.ts，非法项跳过 + warn 不炸启动） */
  hooks?: unknown
}

/** 默认值（P2-1：集中常量，免多处裸魔法值散落；CONFIG_TEMPLATE/writeWizardConfig 是生成给用户的 config.json 字面量） */
const DEFAULT_MAX_ITERATIONS = 50
// F-39 对标 CC toolLimits.DEFAULT_MAX_RESULT_SIZE_CHARS（50K chars 落盘阈值）——
// 单条工具输出给 LLM 的预算默认 50KB（原 30KB 对标的是 CC 旧值）
const DEFAULT_BASH_MAX_BYTES = 50000
const DEFAULT_LOG_LEVEL: Config['logLevel'] = 'info'
/** 批2d（§13.1 拍板-1）：Notification 触发阈值默认 60s（对齐 CC idle 通知默认）；BEL 响铃默认开 */
export const DEFAULT_NOTIFICATION_IDLE_SECONDS = 60
export const DEFAULT_BELL_ON_APPROVAL = true

/** 磁盘格式（jsonc-parser 解析，允许注释） */
interface ConfigFile {
  default?: { provider?: string; model?: string }
  providers?: Record<string, Partial<ProviderCfg>>
  maxIterations?: number
  /** 2026-09-03 拍板：子代理迭代上限（缺省=跟主代理 maxIterations 一致——读取侧 `?? maxIterations` 兜底） */
  subagentMaxIterations?: number
  bashMaxOutputBytes?: number
  /** M9-P3：编辑后自动 lint/test 命令（仅认显式配置；空串/缺省=关闭，不自动探测 package.json） */
  lintCommand?: string
  testCommand?: string
  /** M10-P1：联网搜索（provider 缺省 bing；preferMcp 声明搜索 MCP server 名） */
  webSearch?: { provider?: 'bing' | 'zhipu'; apiKey?: string; engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark'; preferMcp?: string[] }
  /** M9-P4：沙箱（defaultMode: default/accept-edits/read-only/workspace-write/full-access——
   *  启动默认档，宿主构造取它；blockedCommands 通配清单全档硬拒） */
  sandbox?: { defaultMode?: string; blockedCommands?: string[] }
  maxInstructionsKB?: number
  webFetchMaxKB?: number
  logLevel?: string
  mcpServers?: Record<string, import('./mcp/config.js').McpServerConfig>
  /** hooks 原始数组（jsonc 透传；过滤在 hooks/validate.ts） */
  hooks?: unknown
  /** 批2d：Notification 触发阈值秒（缺省 60；0=关） */
  notificationIdleSeconds?: number
  /** 批2d：审批卡首次出现响 BEL（缺省 true） */
  bellOnApproval?: boolean
  /** M13-W2：serve 会话空闲回收分钟（缺省 120；0=不收——补死键：此前磁盘接口漏此字段，写了不生效） */
  sessionIdleMinutes?: number
  /** M13-B2：审批挂起超时毫秒（缺省 900_000=15min；0=不限——补死键同上） */
  approvalTimeoutMs?: number
  /** M13-B3：角色分流（summary=压缩摘要专用便宜模型；校验 provider 名存在） */
  roles?: { summary?: { provider: string; model: string } }
  /** 任务纠偏审查（jsonc 透传；provider 名校验同 roles.summary） */
  review?: {
    enabled: boolean
    provider: string
    model: string
    intervalTurns?: number
    minTurns?: number
    onSignals?: boolean
    timeoutMs?: number
  }
  /** M13-W8：飞书凭据（jsonc 透传） */
  /** 飞书 IM gateway（企业自建应用凭据——配了才激活；长连接免公网）。
   *  allowUsers=open_id 白名单（审阅 P0-1：缺省/空=拒绝所有——p2p bot 整租户可见，
   *  无白名单即开放执行端点） */
  feishu?: { appId: string; appSecret: string; allowUsers?: string[] }
  /** R2：relay 出站连接（jsonc 透传；server/hostToken 必填才激活） */
  relay?: { server: string; hostToken: string; hostId?: string; name?: string; hostBase?: string; phoneBase?: string }
  /** R4：微信 ClawBot（jsonc 透传；botToken 必填才激活） */
  wechat?: { botToken: string; allowUsers?: string[] }
}

export interface LoadConfigOpts {
  /** 自定义 config 路径（默认 ~/.ecode/config.json） */
  configPath?: string
  /** cwd（用于找 .env，默认 process.cwd()） */
  cwd?: string
  /** 是否加载 .env（默认 true，测试可关） */
  loadDotenv?: boolean
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.ecode', 'config.json')
}

/** 首次运行自动生成的模板（JSONC，带注释引导；§4.4）。 */
export const CONFIG_TEMPLATE = `{
  // ECode 配置（首次启动自动生成）。编辑后重启生效，或运行时 /model 切换、/setup 重配。
  // 启动默认选中的 供应商+模型
  "default": { "provider": "astron", "model": "glm-5.2" },

  // 供应商：key=自定义名字，value 含协议/端点/密钥/模型/采样参数
  "providers": {
    "astron": {
      "type": "anthropic",                                  // 协议：anthropic | openai
      "baseURL": "https://open.bigmodel.cn/api/anthropic",  // 端点（示例，按需改）
      "apiKey": "",                                         // ← 必填
      "models": ["glm-5.2"],                                // 可用模型（/model 列这些；可多个）
      "thinking": "medium",                                 // 思考强度：off | low | medium | high
      "maxTokens": ${DEFAULT_MAX_TOKENS},                   // 单次最大输出 token（8192 配 thinking 极易触顶截断——budget 占额后可见文本更少；单源 core/types DEFAULT_MAX_TOKENS）
      // "streamStallMs": 90000,                            // 流停滞看门狗：连续 N ms 无内容输出→中止+零产出自动重试 1 次（缺省 90000；0=关闭；非流式 thinking 端点可调大）
      // "contextWindow": 200000,                           // 上下文窗口覆盖（escape hatch；缺省 models.dev 自动探测）
      // "temperature": 0.7,                                // 采样温度（可选，per-provider）
      // "topP": 0.95                                       // nucleus sampling（可选）
    }
    // 多供应商示例（按需启用）：
    // "deepseek": {
    //   "type": "openai",
    //   "baseURL": "https://api.deepseek.com/v1",
    //   "apiKey": "",
    //   "models": ["deepseek-v4-pro"],
    //   "thinking": "off"
    // }
  },

  // MCP 外部工具（可选）：加进来自动注册工具，/mcp 查看。项目级配置放项目根 .mcp.json（团队共享，首用弹批准）。
  // "mcpServers": {
  //   "filesystem": {                      // 名字自定义（工具名 = mcp__名字__工具名）
  //     "type": "stdio",                   // stdio（拉起本地子进程）| http（连远程）
  //     "command": "npx",                  // stdio 必填
  //     "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  //     "lifecycle": "lazy",               // 默认 lazy（首次调用才连接）；空闲 idleTimeout 分钟（默认 10）自动断开
  //     "timeout": 30000,                  // 单次调用超时 ms（默认 30s）
  //     "env": { "TOKEN": "\${MY_TOKEN}" }  // secret 用环境变量占位符，不落明文（缺失则跳过该 server）
  //   },
  //   "my-http": {
  //     "type": "http",                    // http 必填 url；headers 同样支持 \${ENV_VAR}
  //     "url": "https://mcp.example.com/mcp",
  //     "headers": { "Authorization": "Bearer \${MY_KEY}" }
  //   }
  // },

  "maxIterations": 50,        // Agent 循环最大轮数
  // "subagentMaxIterations": 50, // 子代理（task 工具）迭代上限；缺省=跟 maxIterations
  "bashMaxOutputBytes": 50000, // bash 输出截断阈值（50KB 头尾中截，超限落盘 .outputs/ 可回看——对标 CC 50K chars）
  // M9：编辑后自动 lint/test（空串/缺省=关闭——不会自动探测 package.json，安全默认）
  "lintCommand": "",
  "testCommand": "",
  // M9：沙箱（default=现状=关；blockedCommands 通配全档硬拒，full-access 也不放行）
  "sandbox": { "defaultMode": "default", "blockedCommands": ["git push --force*", "npm publish*"] },
  "autoCommit": false, // M9：编辑轮末自动 git commit（默认关；/undo 只退 ECode 提交）
  // M10：联网搜索（缺省 bing RSS 免费零配置；配了搜索类 MCP 可 preferMcp 声明其名；质量增强可切 zhipu）
  "webSearch": { "provider": "bing" },
  // 批2d：审批等待提示（notificationIdleSeconds 缺省 60，0=关；bellOnApproval 缺省 true）
  // "notificationIdleSeconds": 60,
  // "bellOnApproval": true,
  // M13 serve 常驻（ecode serve 手机/Web 访问；缺省不配=纯本机 127.0.0.1）：
  // "sessionIdleMinutes": 120,            // serve 会话空闲回收分钟（0=不收）
  // "approvalTimeoutMs": 3600000,         // 审批挂起超时 ms（0=不限；D-T8：默认 1h，超时如实告知模型「无人应答」并引导其决策）
  // "feishu": {                           // 飞书 IM 网关（配了凭据 serve 自动激活；长连接免公网）
  //   "appId": "cli_xxx", "appSecret": "\${FEISHU_SECRET}",
  //   "allowUsers": ["ou_xxx"]            // open_id 白名单——缺省/空=拒绝所有（安全默认，必配）
  // }
  // "relay": {                             // R2：relay 出站连接（异地手机接入——配了 serve 自动连中继，纯出站零开端口）
  //   "server": "wss://relay.example.com", // relay 源（自部署见 docs/规范/2026-09-01_ECode-relay自部署指南）
  //   "hostToken": "\${RELAY_TOKEN}",      // relay 的 REG_TOKEN（电脑段准入凭据）
  //   "hostId": "office-pc",               // 本机登记名（多机区分；缺省主机名）
  //   "name": "公司电脑"                    // 手机端显示的别名（可选）
  // },
  // "wechat": {                            // R4：微信 ClawBot（botToken 经 ecode wechat-login 扫码获取）
  //   "botToken": "\${WECHAT_BOT_TOKEN}",
  //   "allowUsers": ["wxid_xxx@im.wechat"] // user id 白名单——缺省/空=拒绝所有（安全默认，必配）
  // }
  // "logLevel": "info",       // 日志级别：debug | info | warn | error
  // "maxInstructionsKB": 32,  // 指令/记忆注入单级上限 KB（ECODE.md/CLAUDE.md/MEMORY.md）
  // "webFetchMaxKB": 30,      // web_fetch 回喂内容上限 KB（头尾中截）
  // "hooks": [                // 事件 hook（M7）：command 子进程，stdin 收事件 JSON
  //   { "event": "PostToolUse", "matcher": "edit_file|write_file",
  //     "handler": { "kind": "command", "command": "prettier ." } }
  // ],
  // "roles": {                // 角色分流（M13）：summary=压缩摘要走便宜模型（不配=会话主模型）
  //   "summary": { "provider": "zhipu-flash", "model": "glm-4.6-flash" }
  // },
  // "review": {               // 任务纠偏审查：主模型跑常规轮，高级模型定时+异常信号出纠偏卡
  //   "enabled": true,        //   开关（false/不配=零行为变化）。注意：启用后近期对话（含工具
  //   "provider": "zhipu",    //   输出）会发送至该 provider 所配端点（与主模型不同厂商时=数据
  //   "model": "glm-5.3",     //   多流向一个端点，自担）；审查费用在 /stats 按模型可见
  //   "intervalTurns": 5,     //   定时兜底：每 N 个用户轮审查一次（默认 5）
  //   "minTurns": 3,          //   长任务才启动：前 N 轮不审（默认 3）
  //   "onSignals": true,      //   异常信号提前触发：连续工具失败/单轮迭代过长（默认 true；每轮最多一次）
  //   "timeoutMs": 60000      //   信号 gate 超时 ms（默认 60000）：超时放行继续，审查结果稍后到达
  // }
}
`

/** 自动生成模板 config（含目录创建）。创建失败抛错。 */
function writeDefaultConfig(cfgPath: string): void {
  // 目录 0o700：config 含 apiKey，目录权限收口（POSIX 生效；Windows 近似 no-op，直接调不分平台）
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(cfgPath, CONFIG_TEMPLATE, 'utf8')
  restrictFileMode(cfgPath)
}

/**
 * 显式收紧文件权限到 0o600（安全审阅 P1）：writeFileSync 的 mode 只对**新建**文件生效，
 * 对已存在文件是 no-op——而模板流程首次就创建过文件（实际 0644），后续写入必须显式 chmod
 * （chmodSync 幂等，POSIX 生效；Windows 上仅影响只读位，近似 no-op，无需分平台）。
 */
function restrictFileMode(filePath: string): void {
  fs.chmodSync(filePath, 0o600)
}

/** 只读解析 cwd 的 .env（F-18 尾巴/批2c）：loadConfig 用局部 dotenvMap，此函数把同一份
 *  暴露给 MCP/serve 等旁路消费方——${ENV_VAR} 占位符与 ECODE_SERVE_* 在 .env 写值时
 *  不再静默失效；绝不 mutate process.env（F-18 根修语义）。读失败返回空 map（与 loadConfig
 *  同为静默降级，那里的 stderr 提示留给持完整 opts 的调用方，避免双打）。 */
export function loadDotenvMap(cwd: string): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(path.join(cwd, '.env'), 'utf8'))
  } catch {
    return {}
  }
}

export function loadConfig(opts: LoadConfigOpts = {}): Config {
  const cwd = opts.cwd ?? process.cwd()

  // .env 加载（dev 内部，不暴露给用户；不存在则静默）。
  // F-18 根修（dogfood 批2a §10.1a）：dotenv.parse 局部 map，绝不 mutate process.env——
  // 旧实现 dotenv.config() 把项目 .env 的 apiKey 明文提升进宿主 env，再经 spawnShellCommand
  // 全量继承透传给 bash/hooks/quality/后台任务子进程（`echo $ANTHROPIC_API_KEY` 即读走），
  // 叠加 prompt injection 即 exfil 链（角色 C 三段实证）。用户 shell 自身 export 的变量
  // 仍继承（用户信任域，与 claude-code 缺省一致），仅「文件密钥主动提升」这一多余环节移除。
  let dotenvMap: Record<string, string> = {}
  if (opts.loadDotenv !== false) {
    try {
      dotenvMap = dotenv.parse(fs.readFileSync(path.join(cwd, '.env'), 'utf8'))
    } catch (e) {
      if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
        // P2-2：不静默吞异常（AGENTS 1.2），stderr 提示（.env 失败不阻断，配置仍从文件读）
        process.stderr.write(`[CONFIG] .env 加载失败（忽略）：${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
  }

  const cfgPath = opts.configPath ?? defaultConfigPath()
  let file: ConfigFile = {}
  let created = false
  try {
    file = parseJsonc(fs.readFileSync(cfgPath, 'utf8')) as ConfigFile
  } catch (e) {
    // P0-1：仅文件不存在（ENOENT）才生成模板；解析失败（用户写坏 JSON）绝不覆盖——否则丢密钥/多 provider 配置
    if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw new Error(
        `[CONFIG_PARSE_FAILED] 配置文件解析失败 ${cfgPath}：${e instanceof Error ? e.message : String(e)}（请手动修复，或删除该文件后重启以生成模板）`,
      )
    }
    try {
      writeDefaultConfig(cfgPath)
      created = true
    } catch (ce) {
      throw new Error(
        `[CONFIG_CREATE_FAILED] 无法创建配置文件 ${cfgPath}: ${ce instanceof Error ? ce.message : String(ce)}`,
      )
    }
    file = {}
  }

  // 选 provider：default.provider 优先，否则第一个，否则 'astron'（默认）
  const providersIn = file.providers ?? {}
  const providerName = file.default?.provider ?? Object.keys(providersIn)[0] ?? 'astron'
  const rawCfg = providersIn[providerName] ?? {}

  // 优先级：外部注入 env > .env 文件 > config > 默认
  // P1-12：统一 env 优先（与 baseURL/apiKey/model 一致），否则 ECODE_TYPE 切 protocol 无效
  // F-18：.env 值走 dotenvMap（不再进 process.env）；外部注入（shell export/spawn env，探针·CI·多环境）
  // 必须压过 .env 文件——dotenv 原生语义即"不覆盖已存在变量"，批2a 首版把 dotenvMap 放最前致探针
  // 注入 mock 端点失效走了真 LLM（2026-08-28 外部验收实证），此处对齐原生语义
  const type = (process.env.ECODE_TYPE ?? dotenvMap.ECODE_TYPE ?? rawCfg.type ?? 'anthropic') as ProviderCfg['type']
  const baseURL = process.env.ECODE_BASE_URL ?? dotenvMap.ECODE_BASE_URL ?? rawCfg.baseURL
  const apiKey = process.env.ANTHROPIC_API_KEY ?? dotenvMap.ANTHROPIC_API_KEY ?? rawCfg.apiKey
  const model = process.env.ECODE_MODEL ?? dotenvMap.ECODE_MODEL ?? file.default?.model ?? rawCfg.models?.[0]

  // 首次生成模板 + env 补全 → 提示可编辑（继续跑）
  if (created && apiKey && baseURL && model) {
    process.stderr.write(`[CONFIG] 已生成配置模板 ${cfgPath}（本次用环境变量运行，可按需编辑模板）\n`)
  }

  // D10：统一有效性校验（不分首次/非首次；错误信息引导 /setup 或编辑 config）
  if (!apiKey) {
    throw new Error(`[NO_API_KEY] 缺少 API Key。请编辑 ${cfgPath} 的 providers.${providerName}.apiKey，或运行 /setup`)
  }
  if (!baseURL) {
    throw new Error(`[NO_BASE_URL] 缺少 baseURL。请编辑 ${cfgPath} 的 providers.${providerName}.baseURL，或运行 /setup`)
  }
  if (!model) {
    throw new Error(`[NO_MODEL] 缺少 model。请编辑 ${cfgPath} 的 default.model，或运行 /setup`)
  }

  // 构造 providers map（磁盘 Partial → 完整 ProviderCfg）
  const providers: Record<string, ProviderCfg> = {}
  for (const [name, cfg] of Object.entries(providersIn)) {
    providers[name] = {
      type: (cfg.type ?? 'anthropic') as ProviderCfg['type'],
      baseURL: cfg.baseURL ?? '',
      apiKey: cfg.apiKey ?? '',
      models: cfg.models ?? [],
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
      ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
      ...(cfg.thinking !== undefined ? { thinking: cfg.thinking as ThinkingLevel } : {}),
      ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
      ...(cfg.streamStallMs !== undefined ? { streamStallMs: cfg.streamStallMs } : {}),
    }
  }
  // env 覆盖当前 provider 关键字段（dev 场景：.env 注入）
  providers[providerName] = {
    ...providers[providerName],
    type,
    baseURL,
    apiKey,
    models: rawCfg.models?.length ? rawCfg.models : [model],
  }

  // M13-B3 启动期校验：roles.summary 的 provider 名必须存在于 providers map
  // （缺失即配置错误——不拖到压缩时才炸；窗口下限校验在装配层，因需异步 resolveContextWindow）
  if (file.roles?.summary !== undefined && providers[file.roles.summary.provider] === undefined) {
    throw new Error(
      `[CONFIG_ROLES_INVALID] roles.summary.provider "${file.roles.summary.provider}" 不存在于 providers（可用：${Object.keys(providers).join(', ')}）——请修正 config.json 的 roles 配置`,
    )
  }
  // 2026-09-02 审查角色校验：**只在 enabled 时拦截**（审阅修复·安全席——可选附加功能的
  // 配置错误不该阻断主功能：用户关掉 review 但 provider 名陈旧时应静默继续）；provider 名
  // 必须存在——审查触发在轮末，配置错误拖到那时才炸会让用户误以为任务出错
  if (file.review !== undefined && file.review.enabled === true) {
    if (providers[file.review.provider] === undefined) {
      throw new Error(
        `[CONFIG_REVIEW_INVALID] review.provider "${file.review.provider}" 不存在于 providers（可用：${Object.keys(providers).join(', ')}）——请修正 config.json 的 review 配置`,
      )
    }
    if (file.review.model === undefined || file.review.model === '') {
      throw new Error('[CONFIG_REVIEW_INVALID] review.enabled=true 但未配 review.model——请补全或设 enabled=false')
    }
    if (
      file.review.timeoutMs !== undefined &&
      (!Number.isFinite(file.review.timeoutMs) || file.review.timeoutMs <= 0)
    ) {
      throw new Error(`[CONFIG_REVIEW_INVALID] review.timeoutMs 必须为正数（收到 ${file.review.timeoutMs}）——信号 gate 超时后放行继续`)
    }
  }
  return {
    providers,
    current: { name: providerName, model },
    ...(file.roles !== undefined ? { roles: file.roles } : {}),
    ...(file.review !== undefined ? { review: file.review } : {}),
    ...(file.feishu !== undefined ? { feishu: file.feishu } : {}),
    // R2：relay 配置透传（hostToken 缺失=配置不完整不激活——防半配置静默起链路）
    ...(file.relay !== undefined && file.relay.server !== '' && file.relay.hostToken !== '' ? { relay: file.relay } : {}),
    ...(file.wechat !== undefined && file.wechat.botToken !== '' ? { wechat: file.wechat } : {}),
    maxIterations: file.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    ...(file.subagentMaxIterations !== undefined && Number.isFinite(file.subagentMaxIterations) && file.subagentMaxIterations > 0
      ? { subagentMaxIterations: Math.floor(file.subagentMaxIterations) }
      : {}),
    bashMaxOutputBytes: file.bashMaxOutputBytes ?? DEFAULT_BASH_MAX_BYTES,
    lintCommand: file.lintCommand,
    webSearch: file.webSearch,
    testCommand: file.testCommand,
    sandbox: file.sandbox !== undefined
      ? {
          defaultMode: SANDBOX_MODES.includes(file.sandbox.defaultMode as SandboxMode)
            ? (file.sandbox.defaultMode as SandboxMode)
            : 'default',
          blockedCommands: file.sandbox.blockedCommands,
        }
      : undefined,
    ...(file.maxInstructionsKB !== undefined ? { maxInstructionsKB: file.maxInstructionsKB } : {}),
    ...(file.webFetchMaxKB !== undefined ? { webFetchMaxKB: file.webFetchMaxKB } : {}),
    logLevel: (file.logLevel as Config['logLevel']) ?? DEFAULT_LOG_LEVEL,
    notificationIdleSeconds: file.notificationIdleSeconds ?? DEFAULT_NOTIFICATION_IDLE_SECONDS,
    bellOnApproval: file.bellOnApproval ?? DEFAULT_BELL_ON_APPROVAL,
    ...(file.sessionIdleMinutes !== undefined ? { sessionIdleMinutes: file.sessionIdleMinutes } : {}),
    ...(file.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: file.approvalTimeoutMs } : {}),
    ...(file.mcpServers !== undefined ? { mcpServers: file.mcpServers } : {}),
  ...(file.hooks !== undefined ? { hooks: file.hooks } : {}),
  }
}

/** 从 Config 派生 ProviderReq（cli argv + TuiApp submit 共用，避免漂移 P1-3） */
export function buildProviderReq(config: Config): ProviderReq {
  const cfg = config.providers[config.current.name]
  return {
    name: config.current.name,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: config.current.model,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
    ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
    ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
    ...(cfg.streamStallMs !== undefined ? { streamStallMs: cfg.streamStallMs } : {}),
  }
}

/** M13-B3：按 provider 名 + model 构造指定角色的 ProviderReq（roles.summary 装配用） */
export function buildProviderReqFor(config: Config, providerName: string, model: string): ProviderReq {
  const cfg = config.providers[providerName]
  return {
    name: providerName,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
    ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
    ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
    ...(cfg.streamStallMs !== undefined ? { streamStallMs: cfg.streamStallMs } : {}),
  }
}

/** /setup 向导收集的值（writeWizardConfig 用） */
export interface WizardValues {
  /** 操作模式：add=新增 provider / edit=编辑现有。首次（无 config）走 add */
  mode: 'add' | 'edit'
  /** 目标 provider 名（add 时用户输入；edit 时为现有名） */
  providerName: string
  type: 'anthropic' | 'openai'
  baseURL: string
  apiKey: string
  models: string // 逗号分隔（写时 split + trim → string[]）
  thinking: ThinkingLevel
}

/** 向导值的 provider 对象（modify 写入用；字段顺序与 CONFIG_TEMPLATE 一致） */
function wizardProviderObject(values: WizardValues): Record<string, unknown> {
  const models = values.models.split(',').map((s) => s.trim()).filter(Boolean)
  return {
    type: values.type,
    baseURL: values.baseURL,
    apiKey: values.apiKey,
    models,
    thinking: values.thinking,
    maxTokens: DEFAULT_MAX_TOKENS, // 8192 配 thinking 极易触顶截断（max_tokens_truncated）——单源 core/types，与模板/provider 兜底同值
  }
}

/**
 * 向导值 → 合并进 config.json（增量改单个 provider；§10.1 步骤 6）。
 *
 * 用 jsonc-parser modify/applyEdits 基于文本偏移编辑，**保留所有注释和未触及的 provider**
 * （区别于旧版整文件覆写——P1-5 修复）。
 *   - mode=add：新 provider 插入 providers map + default 自动切到新 provider（立即生效）
 *   - mode=edit：覆盖现有 provider 字段，不动 default（用户可能已 /model 切过）
 *   - config 不存在：用 CONFIG_TEMPLATE 作底（mode 强制 add）
 *
 * 文件权限 600（Windows chmod 弱化尽力，Linux/macOS 生效）。
 */
export function writeWizardConfig(values: WizardValues, opts: { configPath?: string } = {}): void {
  // P1-4：写前校验空值——防误按回车用空值覆盖有效 config
  if (!values.providerName.trim()) throw new Error('[SETUP_INCOMPLETE] provider 名不能为空')
  if (!values.baseURL.trim()) throw new Error('[SETUP_INCOMPLETE] baseURL 不能为空')
  if (!values.apiKey.trim()) throw new Error('[SETUP_INCOMPLETE] apiKey 不能为空')
  if (!values.models.trim()) throw new Error('[SETUP_INCOMPLETE] model 不能为空')

  const cfgPath = opts.configPath ?? defaultConfigPath()
  const fmt: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' }
  const models = values.models.split(',').map((s) => s.trim()).filter(Boolean)

  // 读现有文本（不存在 → CONFIG_TEMPLATE 作底，强制 add 语义）
  let text: string
  let fileExists = true
  try {
    text = fs.readFileSync(cfgPath, 'utf8')
  } catch {
    text = CONFIG_TEMPLATE
    fileExists = false
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 })
  // P1-5：写前备份现有 config（modify 算错可从 .bak 恢复）
  if (fileExists) {
    try {
      fs.copyFileSync(cfgPath, cfgPath + '.bak')
      restrictFileMode(cfgPath + '.bak') // .bak 同样含 apiKey，权限必须跟上（安全审阅 P1）
    } catch {
      // 备份失败不阻断写入（只读 fs 等极端情况，尽力）
    }
  }

  // 增量编辑：modify 计算最小文本编辑（保留注释/未触及内容）→ applyEdits 应用
  // 关键：每次 modify 基于上一次 applyEdits 的结果文本（不能基于原 text，否则多次编辑偏移错位）
  let result = applyEdits(text, modify(text, ['providers', values.providerName], wizardProviderObject(values), { formattingOptions: fmt }))
  // 新增模式：default 自动切到新 provider（立即生效）；编辑模式不动 default
  if (values.mode === 'add' || !fileExists) {
    result = applyEdits(result, modify(result, ['default'], { provider: values.providerName, model: models[0] ?? '' }, { formattingOptions: fmt }))
  }
  fs.writeFileSync(cfgPath, result, { mode: 0o600 })
  restrictFileMode(cfgPath) // mode 对已存在文件不生效（安全审阅 P1），显式 chmod 兜底
}

/** 配置无效态空壳（P0-4）：cli catch loadConfig 失败时构造，TuiApp 仍能渲染（banner + /setup 可用）。 */
export function emptyShellConfig(): Config {
  return {
    providers: {},
    current: { name: '', model: '' },
    maxIterations: DEFAULT_MAX_ITERATIONS,
    bashMaxOutputBytes: DEFAULT_BASH_MAX_BYTES,
    logLevel: DEFAULT_LOG_LEVEL,
    notificationIdleSeconds: DEFAULT_NOTIFICATION_IDLE_SECONDS,
    bellOnApproval: DEFAULT_BELL_ON_APPROVAL,
  }
}
