import type { ReactElement } from 'react'
import { Text, Box } from 'ink'
import { symbols } from './symbols.js'
import { theme } from './theme.js'
import { GAP, INDENT } from './layout.js'

/** 用户消息：背景块 + F-36 栅格（2026-08-29 用户拍板与对话内容同栅格——第一列 ❯ 图标槽、
 *  内容从第 2 列起、折行续行不占第 1 列；原「整块背景+行内 ❯」CC 例外形态退役——行内前缀
 *  的折行续行顶到第 0 列，正是用户点名的不一致）。文字保持亮色，靠背景区分（CC 调研结论仍适用）。
 *  不直接用 MessageRow：其自带 marginTop，嵌进背景块会出双倍间隙——这里内联同构栅格。
 *  二次修正（同日）：去 paddingLeft——背景块左 padding 曾把 ❯ 顶到第 1 列，严格对齐第 0 列。 */
export function UserMessage({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={GAP.block} backgroundColor={theme.userBg} paddingRight={1}>
      <Box flexDirection="row">
        <Box minWidth={INDENT.icon} flexShrink={0}>
          <Text color={theme.info} bold>{symbols.prompt}</Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          <Text color={theme.user}>{text}</Text>
        </Box>
      </Box>
    </Box>
  )
}
