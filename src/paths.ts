// 数据目录统一入口（§9.3 跨 Windows/WSL 红线：不散用 homedir() / '~' / '$HOME' 定位数据目录）。
// M5 各模块（subagent loader / mcp registry / user hooks / config / settings）复用本入口。
//
// 一期：纯提取——把分散的 `homedir() + '.ecode'` 收口成单一函数，行为不变（§1.7 不改语义）。
// 自探测「对端 home」（WSL↔Windows 混合环境，cmd.exe echo %USERPROFILE% + wslpath）留 §9.3 增强，
// 避免一期引入跨进程探测复杂度；将来增强只改本文件一处，调用方零改动。
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析 ECode 数据目录（`~/.ecode`），跨平台单一入口。
 *
 * 优先级（§9.3 设计，一期只落地第 2 档）：
 *   1. 显式 / env 覆盖 —— 一期不做（§1.1 零配置自探测优先，不引入外部环境依赖）
 *   2. 默认：当前进程 home 下的 `.ecode`（一期行为，与历史一致）
 *   3.（增强预留）自探测对端 home —— WSL 跑构建/Windows 跑进程时两套 home 对不上的兜底
 *
 * @returns 数据目录绝对路径，如 `C:\Users\xxx\.ecode` / `/home/xxx/.ecode`
 */
export function resolveDataDir(): string {
  return join(homedir(), '.ecode');
}
