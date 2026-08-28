/**
 * 输入历史持久化（界面批 A2）：项目级 `.ecode/input-history.json`。
 *
 * 选型理由（数据分层原则）：输入历史「跟会话/项目走」——同一项目下重开 ECode 应能 ↑↓
 * 回溯此前输入（对齐 CC「按工作目录存储」），跨项目互不相干；故落项目级 .ecode/ 而非
 * 用户级 ~/.ecode/（用户级sessions 是对话落盘，输入历史是工作区操作痕迹，随项目走）。
 * 格式：{ entries: string[] }（旧→新，尾部最新）；去重（重复输入移到尾部）+ 上限 500 FIFO。
 * 同步写（追加频率低，与 HistoryStore 同款可靠性取舍）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** 上限（FIFO） */
export const INPUT_HISTORY_MAX = 500

function filePathOf(cwd: string): string {
  return path.join(cwd, '.ecode', 'input-history.json')
}

/** 读取（文件缺失/损坏返回 []——历史是增强，不因损坏崩输入流） */
export function loadInputHistory(cwd: string): string[] {
  try {
    const raw = fs.readFileSync(filePathOf(cwd), 'utf8')
    const parsed = JSON.parse(raw) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter((e): e is string => typeof e === 'string').slice(-INPUT_HISTORY_MAX)
  } catch {
    return []
  }
}

/** 追加一条（去重移尾 + FIFO 截断；空串忽略；写失败静默——不影响输入流） */
export function appendInputHistory(cwd: string, text: string): void {
  const t = text.trim()
  if (t === '') return
  const entries = loadInputHistory(cwd).filter((e) => e !== t)
  entries.push(t)
  const trimmed = entries.length > INPUT_HISTORY_MAX ? entries.slice(entries.length - INPUT_HISTORY_MAX) : entries
  try {
    fs.mkdirSync(path.join(cwd, '.ecode'), { recursive: true })
    fs.writeFileSync(filePathOf(cwd), JSON.stringify({ entries: trimmed }), 'utf8')
  } catch {
    /* 只读目录/权限等：历史不落盘，会话内仍可用 */
  }
}
