/**
 * 消息行栅格（F-36 布局统一批）——「第一列只放图标，所有文字含折行续行从第 2 列起」的唯一实现。
 *
 * CC 同构（AssistantTextMessage t4/t6 模式，源码实证）：左轨圆点槽 minWidth=2 不可压缩，
 * 正文列 flex 吃满剩余宽；正文预折宽 = WIDTH.body（= 内容列宽），续行经 Ink 布局
 * 全部落在同一 x 偏移 = 悬挂缩进是布局副产品，不是拼空格。CC 里 2/5 槽宽是散落
 * 魔法数字（三处注释互证），ECode 收口在 layout.ts INDENT。
 *
 * icon='' → 空 2 列槽（系统级提示行占位对齐，CC BriefTool 空 minWidth=2 同款）。
 * 用户消息不进本栅格（CC 例外：整块背景 + 行内 ❯）。
 */
import type { ReactElement, ReactNode } from 'react'
import { Box, Text } from 'ink'
import { symbols } from './symbols.js'
import { GAP, INDENT } from './layout.js'

interface MessageRowProps {
  /** 左轨符号（1 列宽字符，居 2 列槽）；'' = 空槽只占位 */
  icon?: string
  /** 符号置灰（次级系统行） */
  dim?: boolean
  children: ReactNode
}

export function MessageRow({ icon = symbols.tool, dim = false, children }: MessageRowProps): ReactElement {
  return (
    <Box flexDirection="row" marginTop={GAP.block}>
      <Box minWidth={INDENT.icon} flexShrink={0}>
        {icon !== '' && <Text dimColor={dim}>{icon}</Text>}
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}
