/**
 * TUI 全局状态 Context（TUI 规范 §8：React Context 轻量全局状态）。
 *
 * 状态：messages（对话）/ activity（ActivityBar）/ abortController（中断）。
 * Provider 在 App.tsx（第 3 步）；本文件提供 Context + useTui hook。
 * 焦点由 Ink useFocusManager 管，不进 store。
 */

import { createContext, useContext } from 'react'
import type { Message } from '../core/types.js'
import type { ActivityState } from '../core/loop.js'

export interface ActivityInfo {
  state: ActivityState
  text?: string
}

export interface TuiState {
  messages: Message[]
  activity: ActivityInfo
  abortController: AbortController
}

export const TuiContext = createContext<TuiState | null>(null)

export function useTui(): TuiState {
  const v = useContext(TuiContext)
  if (!v) throw new Error('useTui 必须在 <TuiProvider> 内使用')
  return v
}
