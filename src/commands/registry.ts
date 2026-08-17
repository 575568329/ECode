/**
 * 斜杠命令注册（M2 决策 10：CommandRegistry 统一管理；skill 作为 Command 的一种，留接口）。
 *
 * M2 内置 /help /clear；未来 skill / 管理命令注册进来，心脏零改动。
 * 命令的副作用通过 action 字段交回调用方（InputStream/App）解释，保持 registry 纯逻辑。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { sep } from 'node:path'

/** 命令执行结果：输出文本（给用户）+ 可选副作用 action */
export interface CommandResult {
  /** 给用户的输出文本（如 /help 的列表） */
  output?: string
  /** action 附带参数（如 /mcp reconnect db 的 server 名） */
  payload?: string
  /** 副作用 action（由调用方解释：clear=清空会话 / expand=展开折叠工具输出 / pick-model=弹模型选择器 / pick-history=弹历史选择器 / start-setup=弹配置向导） */
  action?:
    | 'clear'
    | 'expand'
    | 'pick-model'
    | 'pick-history'
    | 'start-setup'
    | 'compact'
    | 'cost'
    | 'skill-panel'
    | 'skill-create'
    | 'open-mcp-panel'
    | 'mcp-reconnect'
    | 'open-plugin-panel'
    | 'open-warnings-panel'
    | 'open-rewind-panel'
    | 'open-sandbox-panel'
    | 'git-undo'
    | 'open-config-panel'
    | 'restart'
    | 'inject-prompt'
}

export interface Command {
  /** 命令名（不含 /，如 'help'） */
  name: string
  description: string
  /** 执行；args = 命令名后的参数文本（如 `/mcp reconnect db` → 'reconnect db'），无参 undefined */
  run: (args?: string) => CommandResult
}

export class CommandRegistry {
  private commands = new Map<string, Command>()

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd)
  }

  get(name: string): Command | undefined {
    return this.commands.get(name)
  }

  /** 注销（M7 plugin disable/uninstall 反注册其贡献的命令；不存在时静默——与 ToolRegistry 语义一致）。 */
  unregister(name: string): void {
    this.commands.delete(name)
  }

  list(): Command[] {
    return [...this.commands.values()]
  }

  /** 前缀匹配（用于 / 补全） */
  match(prefix: string): Command[] {
    return this.list().filter((c) => c.name.startsWith(prefix))
  }

  clear(): void {
    this.commands.clear()
  }
}

/** 全局单例（App 启动时 registerBuiltinCommands） */
export const commandRegistry = new CommandRegistry()

/** 注册 M2 内置命令（幂等，重复调用覆盖） */
export function registerBuiltinCommands(registry: CommandRegistry = commandRegistry): void {
  registry.register({
    name: 'help',
    description: '列出所有命令',
    run: () => ({
      output: registry
        .list()
        .map((c) => `  /${c.name}  ${c.description}`)
        .join('\n'),
    }),
  })
  registry.register({
    name: 'clear',
    description: '清空当前会话',
    run: () => ({ action: 'clear' }),
  })
  registry.register({
    name: 'expand',
    description: '展开/折叠工具输出',
    run: () => ({ action: 'expand' }),
  })
  registry.register({
    name: 'model',
    description: '切换供应商/模型',
    run: () => ({ action: 'pick-model' }),
  })
  registry.register({
    name: 'history',
    description: '列出/恢复历史会话',
    run: () => ({ action: 'pick-history' }),
  })
  registry.register({
    name: 'setup',
    description: '配置向导（重配供应商/密钥）',
    run: () => ({ action: 'start-setup' }),
  })
  registry.register({
    name: 'compact',
    description: '手动压缩对话（摘要旧消息，释放上下文）',
    run: () => ({ action: 'compact' }),
  })
  registry.register({
    name: 'cost',
    description: '查看 token 用量与成本',
    run: () => ({ action: 'cost' }),
  })
  registry.register({
    name: 'skill',
    description: '浏览/选用 Skill（面板）',
    run: () => ({ action: 'skill-panel' }),
  })
  registry.register({
    name: 'skill-create',
    description: '从当前会话蒸馏 Skill（起草→预览→创建/升级）',
    run: () => ({ action: 'skill-create' }),
  })
  registry.register({
    name: 'mcp',
    description: 'MCP 服务管理（面板；/mcp reconnect <name> 直达）',
    run: (args?: string) => {
      if (args !== undefined && args.startsWith('reconnect')) {
        const target = args.slice('reconnect'.length).trim()
        return { action: 'mcp-reconnect' as const, ...(target !== '' ? { payload: target } : {}) }
      }
      return { action: 'open-mcp-panel' as const }
    },
  })
  registry.register({
    name: 'plugin',
    description: '插件管理（浏览市场/安装/启停/卸载，面板）',
    run: () => ({ action: 'open-plugin-panel' as const }),
  })
  registry.register({
    name: 'warnings',
    description: '告警中心（查看全部 提示/警告/严重 问题的队列）',
    run: () => ({ action: 'open-warnings-panel' as const }),
  })
  registry.register({
    name: 'sandbox',
    description: '沙箱模式切换（default/read-only/workspace-write/full-access；Tab 快捷循环）',
    run: () => ({ action: 'open-sandbox-panel' as const }),
  })
  registry.register({
    name: 'undo',
    description: '撤销最近一次 ECode 自动提交（带 Ecode-Commit 标记的才退，用户提交绝不动）',
    run: () => ({ action: 'git-undo' as const }),
  })
  registry.register({
    name: 'rewind',
    description: '回退到某次改动之前（文件还原 + 对话回退，面板）',
    run: () => ({ action: 'open-rewind-panel' as const }),
  })
  registry.register({
    name: 'doctor',
    description: '自检配置与文档（config/ECODE.md/memory 索引/hooks/MCP——LLM 检查，你决策）',
    run: (args?: string) => ({ action: 'inject-prompt' as const, payload: buildDoctorPrompt(args) }),
  })
  registry.register({
    name: 'restart',
    description: '重启 ECode（改 config/hooks 后生效用；会话历史保留，/history 可恢复）',
    run: () => ({ action: 'restart' as const }),
  })
  // /config：面板全平台（v1.9——explorer 逃生口才限桌面平台，面板本身无平台依赖）
  registry.register({
    name: 'config',
    description: '配置面板（三页签可视化改；jsonc 非破坏保存；/model 仍是会话内切换）',
    run: () => ({ action: 'open-config-panel' as const }),
  })
}

/**
 * /doctor 自检指令（M8 补充④）：注入给 LLM 的检查清单——LLM 逐项读文件核查，
 * 产出问题报告与建议；明确"只报告不修改"，修复动作由用户决策。
 * 运行时构造（审阅 P1-4）：~ 路径按本机 homedir 展开（read_file 不认 ~）；
 * 截断上限透传实际配置（不写死 32KB）；第 7 项（活文档抽查）只在 ECode 开发仓库
 * 内运行时注入——普通项目里 src/docs 不存在，注入只会产噪。
 */
export function buildDoctorPrompt(args?: string): string {
  const home = homedir().split(sep).join('/')
  const inECodeRepo = existsSync('src/core/system.ts') && existsSync('docs/README.md')
  const item7 = inECodeRepo
    ? `7. 提示词与文档同步（活文档抽查，依据 docs/规范/2026-08-16_活文档清单与同步守则_已完成.md）：读 src/core/system.ts 的工具选择指引，与实际注册的工具集对照（有无工具在指引里缺席）；读 src/services/config.ts 的 CONFIG_TEMPLATE 注释与 docs/规范 内 TUI 规范的键位表，抽查是否覆盖最新功能（如告警中心/分页键位/新配置键）；发现过时内容只报告位置与差异，不要直接改。
`
    : ''
  return `请对 ECode 的配置与文档做一次自检（只读取与报告，不要做任何修改——修复由我决策后另行指示）。逐项检查并汇总：

1. 配置：读 ${home}/.ecode/config.json——能否解析、default 指向的 provider 是否存在、必填字段（baseURL/apiKey/models）是否齐全、有无被注释掉但看起来想启用的配置。
2. 指令文件：检查 ${home}/.ecode/ECODE.md 与项目级（从当前目录向上找 ECODE.md 或 CLAUDE.md）——是否存在、大小是否接近截断上限（第 1 项读 config 时顺带核对 maxInstructionsKB 的值，未配置则默认 32KB）。
3. 记忆索引：读用户级与项目级 MEMORY.md——索引里每条引用的主题文件是否真实存在（缺文件）；同目录是否有 .md 主题文件未被索引收录（缺索引）。
4. Hooks：config.json 的 hooks 键各项是否合法（event 名/command 非空）；skill 目录的 hooks.json 是否可解析。
5. MCP：项目级 .mcp.json 是否可解析、server 必填字段是否齐全（stdio 要 command / http 要 url）。
6. Skills：各 skill 的 SKILL.md frontmatter 是否含 name 与 description。
${item7}8. 权限规则（M9-P5 配套自查）：检查三层 settings——${home}/.ecode/settings.json（用户级）、项目根 .ecode/settings.json（团队共享进 git）与 .ecode/settings.local.json（local 层，弹窗「永久记住」的落点）——存在的文件能否解析、permissions.allow/ask/deny 每条是否为 Type(param) 形态（如 Hook(skill:foo)、括号内尾 * 通配）；语法不合法的规则永不匹配（静默失效），解析失败的层按无规则处理（表现为反复弹询问）——两者都要报告。
输出格式：按 检查项 → 状态（正常/警告/问题）→ 问题描述与建议修复法 列表；全部正常也要明确说"全部正常"。${args !== undefined && args.trim() !== '' ? `
额外关注：${args.trim()}` : ''}`
}
