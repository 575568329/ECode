// 斜杠命令解析 + 注册表（纯逻辑，UI 无关）。
// 阶段①只做「识别 + 分流」，命令执行（清屏/退出/切模型）由消费方处理。

export interface SlashCommandDef {
  name: string;
  description: string;
}

/** MVP 命令注册表（声明式，新增命令加一条） */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'help', description: '显示可用命令' },
  { name: 'clear', description: '清空对话历史' },
  { name: 'model', description: '切换模型（如 /model deepseek）' },
  { name: 'exit', description: '退出 ECode' },
];

export type ParsedInput =
  | { type: 'command'; name: string; args: string[] }
  | { type: 'unknown_command'; raw: string }
  | { type: 'message'; text: string };

/**
 * 解析用户输入：/ 开头且命中注册表 → command；/ 开头未命中 → unknown_command；否则 → message。
 */
export function parseUserInput(input: string): ParsedInput {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { type: 'message', text: input };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0];
  const args = parts.slice(1);
  const known = SLASH_COMMANDS.some((c) => c.name === name);
  if (!known) {
    return { type: 'unknown_command', raw: trimmed };
  }
  return { type: 'command', name, args };
}
