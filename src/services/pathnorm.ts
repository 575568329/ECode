/**
 * 项目路径规范形态（审阅 P1-2/P1-3 抽出共用）：realpath + 正斜杠。
 *
 * 背景：本项目存在三种 cwd 形态——process.cwd() 原始形态（REPL/argv 建档落盘 meta.cwd）、
 * realpath 规范形态（ProjectRegistry 注册/活表）、仅正斜杠替换形态（旧 cwdOf）。比较侧
 * 两两不同形态则永不相等：Windows 下默认项目恒误判冷项目（running 注入失效）、REPL 会话
 * 在 web 列表消失。所有跨来源的路径比较统一经此函数（realpath 失败——目录已删/跨盘——
 * 退正斜杠归一，保证两两同形态）。
 */
import { realpathSync } from 'node:fs'

export function normalizeProjectPath(p: string): string {
  const fwd = (s: string): string => s.split('\\').join('/')
  try {
    return fwd(realpathSync(p))
  } catch {
    return fwd(p)
  }
}
