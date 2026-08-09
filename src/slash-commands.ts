// 斜杠命令解析 + 注册表（纯逻辑，UI 无关）。
//
// 设计（阶段 3 MCP 前置：斜杠命令注册式重构）：
//   - SLASH_COMMANDS = 内置命令静态列表（name+description，无 execute —— execute 在 app 层闭包注册）。
//   - 动态命令（MCP prompt → `/mcp__server__prompt`）通过 registerCommand(def) 注册。
//   - parseUserInput 识别全部命令（内置 + 动态）；handleCommand 通过 findCommandHandler dispatch。
//   - 行为不变：新增 registerCommand/unregisterCommand/getAllCommands/findCommandHandler 四个出口。

export interface SlashCommandDef {
  name: string;
  description: string;
  /** 位置参数名（MCP prompt 用：typeahead 生成 [arg] hint）。内置命令无此字段。 */
  argNames?: string[];
  /** 来源：builtin（内置，/help 展示）/ mcp（动态注册）。 */
  source?: 'builtin' | 'mcp';
  /** 命令执行回调（动态命令自带；内置命令在 app 层通过 registerCommandHandler 注册）。 */
  execute?: CommandHandler;
}

/** 命令执行回调签名：args=位置参数，ctx=运行时上下文。支持同步（exit/clear 等）。 */
export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<void> | void;

/** 命令执行上下文（app 层构建，按需扩展）。addMessage 用 rest unknown 避免 slash-commands.ts 依赖 UI 类型。 */
export interface CommandContext {
  addMessage: (...args: unknown[]) => void;
  /** 其他上下文由闭包捕获（setCurrentModel/setResumeOpen 等），不纳入接口避免膨胀。 */
}

/**
 * 内置命令注册表（声明式，8 个，无 execute）。
 * 保持导出名 SLASH_COMMANDS 向后兼容（测试/docs/parseUserInput 已引用）。
 */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'help', description: '显示可用命令', source: 'builtin' },
  { name: 'clear', description: '清空对话历史', source: 'builtin' },
  { name: 'model', description: '切换模型（如 /model deepseek）', source: 'builtin' },
  { name: 'exit', description: '退出 ECode', source: 'builtin' },
  { name: 'cost', description: '显示当前会话 token 用量', source: 'builtin' },
  { name: 'compact', description: '手动触发上下文压缩', source: 'builtin' },
  { name: 'resume', description: '显示会话恢复面板', source: 'builtin' },
  { name: 'sessions', description: '列出项目会话', source: 'builtin' },
  { name: 'mcp', description: '查看/管理 MCP servers', source: 'builtin' },
  { name: 'skill', description: '使用技能（如 /skill deploy），无参列出可用技能', argNames: ['name'], source: 'builtin' },
  { name: 'skill-gen', description: '从观察记录归纳生成技能提案（/skill 审批）', source: 'builtin' },
];

// ---- 动态命令注册表（MCP prompt 等运行时注册）----

const dynamicCommands: SlashCommandDef[] = [];

/** 注册一条动态命令（同名将替换；同时注册其 execute 到 handler 表）。 */
export function registerCommand(def: SlashCommandDef): void {
  unregisterCommand(def.name); // 同名先清
  dynamicCommands.push(def);
  if (def.execute) handlerRegistry.set(def.name, def.execute);
}

/** 注销一条动态命令（不会注销内置命令）。 */
export function unregisterCommand(name: string): void {
  const idx = dynamicCommands.findIndex((c) => c.name === name);
  if (idx >= 0) dynamicCommands.splice(idx, 1);
  handlerRegistry.delete(name);
}

/** 获取全部命令列表（内置 + 动态，供 parseUserInput 识别 + /help 展示）。 */
export function getAllCommands(): SlashCommandDef[] {
  return [...SLASH_COMMANDS, ...dynamicCommands];
}

// ---- Handler 注册表（内置命令在 app 层注册，动态命令通过 registerCommand 自带）----

const handlerRegistry = new Map<string, CommandHandler>();

/** 注册内置命令的执行回调（app 层闭包，捕获 UI 状态）。 */
export function registerCommandHandler(name: string, handler: CommandHandler): void {
  handlerRegistry.set(name, handler);
}

/** 查找命令 handler（handleCommand dispatch 用）。 */
export function findCommandHandler(name: string): CommandHandler | undefined {
  return handlerRegistry.get(name);
}

// ---- 解析 ----

export type ParsedInput =
  | { type: 'command'; name: string; args: string[] }
  | { type: 'unknown_command'; raw: string }
  | { type: 'message'; text: string };

/**
 * 解析用户输入：/ 开头且命中全部命令（内置+动态）→ command；/ 开头未命中 → unknown_command；否则 → message。
 */
export function parseUserInput(input: string): ParsedInput {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { type: 'message', text: input };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0];
  const args = parts.slice(1);
  const known = getAllCommands().some((c) => c.name === name);
  if (!known) {
    return { type: 'unknown_command', raw: trimmed };
  }
  return { type: 'command', name, args };
}
