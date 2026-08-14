/**
 * 斜杠命令注册（M2 决策 10：CommandRegistry 统一管理；skill 作为 Command 的一种，留接口）。
 *
 * M2 内置 /help /clear；未来 skill / 管理命令注册进来，心脏零改动。
 * 命令的副作用通过 action 字段交回调用方（InputStream/App）解释，保持 registry 纯逻辑。
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { defaultConfigPath } from '../services/config.js'

/** 命令执行结果：输出文本（给用户）+ 可选副作用 action */
export interface CommandResult {
  /** 给用户的输出文本（如 /help 的列表） */
  output?: string
  /** 副作用 action（由调用方解释：clear=清空会话 / expand=展开折叠工具输出 / pick-model=弹模型选择器 / pick-history=弹历史选择器 / start-setup=弹配置向导） */
  action?: 'clear' | 'expand' | 'pick-model' | 'pick-history' | 'start-setup' | 'compact'
}

export interface Command {
  /** 命令名（不含 /，如 'help'） */
  name: string
  description: string
  run: () => CommandResult
}

export class CommandRegistry {
  private commands = new Map<string, Command>()

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd)
  }

  get(name: string): Command | undefined {
    return this.commands.get(name)
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
  // /config：仅桌面平台注册（win32=explorer / darwin=open；linux·WSL 无可靠 opener → 用 /setup）
  if (process.platform === 'win32' || process.platform === 'darwin') {
    registry.register({
      name: 'config',
      description: '打开配置文件夹',
      run: () => {
        const dir = path.dirname(defaultConfigPath())
        const cmd = process.platform === 'win32' ? 'explorer' : 'open'
        try {
          // P1-11：spawn 失败（ENOENT 等）异步发 'error'，必须有监听否则 uncaughtException → exit
          const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
          child.on('error', (e) => {
            process.stderr.write(`[CONFIG] 打开文件夹失败（${cmd} 未找到？）：${e.message}\n`)
          })
          child.unref()
        } catch (e) {
          return { output: `打开配置文件夹失败：${e instanceof Error ? e.message : String(e)}` }
        }
        return { output: '已打开 ~/.ecode 配置文件夹（编辑后重启生效）' }
      },
    })
  }
}
