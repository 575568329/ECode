import { Fragment } from 'react'
import type { ReactElement } from 'react'
import { Text } from 'ink'
import type { FoldResult } from './viewport.js'

/**
 * 折叠展示件（M14 §3.2，V1）：折叠提示行 + 可见物理行。
 *
 * 提示行按 fold.markerAt 插在头段与尾段之间（tail 模式在最上方）；
 * 未折叠时零开销（只渲染可见行，无提示行）。数据来自 foldLines——
 * 渲染层不做任何测量与再计算。
 */
interface FoldedProps {
  fold: FoldResult
  /** 提示行附加说明（如 'Ctrl+O 展开 · Ctrl+T 查看'） */
  hint?: string
  /** 可见行是否暗色（流式灰字/预览类内容） */
  dim?: boolean
}

export function Folded({ fold, hint, dim = false }: FoldedProps): ReactElement {
  const head = fold.visible.slice(0, fold.markerAt)
  const tail = fold.visible.slice(fold.markerAt)
  return (
    <Fragment>
      {head.length > 0 && <Text dimColor={dim}>{head.join('\n')}</Text>}
      {fold.foldedCount > 0 && (
        <Text dimColor>
          {`↑ ${fold.foldedCount} 行已折叠（共 ${fold.totalPhysical} 行）${hint !== undefined ? ` · ${hint}` : ''}`}
        </Text>
      )}
      {tail.length > 0 && <Text dimColor={dim}>{tail.join('\n')}</Text>}
    </Fragment>
  )
}
