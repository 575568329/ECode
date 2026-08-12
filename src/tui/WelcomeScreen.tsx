import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { theme } from './theme.js'

interface WelcomeScreenProps {
  version?: string
  model?: string
  cwd?: string
  /** 错误（如 config 缺失 / 缺 apiKey）；有则显示 ✗，无则显示引导（TUI 规范 §4.1） */
  error?: string
}

/** 品牌启动屏（TUI 规范 §4.1）：版本 / model / cwd + 引导或错误提示 */
export function WelcomeScreen({ version, model, cwd, error }: WelcomeScreenProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.status}>
        ECode{version !== undefined ? ` v${version}` : ''}
      </Text>
      {model !== undefined && <Text dimColor>model: {model}</Text>}
      {cwd !== undefined && <Text dimColor>cwd: {cwd}</Text>}
      {error !== undefined ? (
        <Text color={theme.error}>✗ {error}</Text>
      ) : (
        <Text dimColor>输入消息开始，/help 查看命令</Text>
      )}
    </Box>
  )
}
