/**
 * 工具 digest 单源（活动流 B2，详设 v1.7 §4/P1-1）：
 * 宿主（item/executing 帧生成）、web（历史行 digest）、TUI（运行行渲染）三方共用的
 * 「工具入参 → 单行摘要」规则——此前 tui/toolview.ts 的 inputDigest（path??command??pattern，
 * 无截断无兜底）只服务 TUI 折叠态，宿主引用它=反向依赖（tui 是客户端表现层），web 复刻=双份漂移。
 *
 * 规则：bash=command 取首行、按显示宽度截 60 列；read_file/glob/grep=路径或 pattern；
 * edit_file/write_file=路径；未知工具=name 兜底。生成即净化（digest 派生自工具 input，
 * bash 的 command 模型可直接写转义序列——OSC 52 覆写剪贴板/OSC 8 钓鱼，S1 修过的事故面不重开）。
 */
import stringWidth from 'string-width'
import { stripUntrustedAnsi } from './sanitize.js'

/** digest 显示宽度上限（列）——loading 行/工具行恒单物理行的前提 */
const DIGEST_MAX_COLUMNS = 60

/** 按显示宽度截断（CJK 占 2 列；与 tui/viewport clipWidth 同口径——此处独立实现避免 protocol→tui 反向依赖） */
function clipColumns(text: string, max: number): string {
  if (stringWidth(text) <= max) return text
  let out = ''
  for (const ch of text) {
    if (stringWidth(out + ch) > max - 1) break
    out += ch
  }
  return `${out}…`
}

/** 路径类工具的 digest 字段优先级（path > pattern > query 等常见字段） */
const PATH_FIELDS = ['path', 'pattern', 'query', 'url', 'file'] as const

/** 工具入参 → 单行摘要（净化+截断出口；纯函数可单测） */
export function makeToolDigest(name: string, input: unknown): string {
  let raw = ''
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === 'string' && obj.command !== '') {
      raw = obj.command.split('\n')[0] ?? ''
    } else {
      for (const f of PATH_FIELDS) {
        const v = obj[f]
        if (typeof v === 'string' && v !== '') {
          raw = v
          break
        }
      }
    }
  }
  if (raw === '') raw = name
  return clipColumns(stripUntrustedAnsi(raw).trim(), DIGEST_MAX_COLUMNS)
}
