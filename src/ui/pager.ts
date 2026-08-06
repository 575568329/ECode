// pager —— 封装 less pager 调用（spawn + stdin pipe）。
// alternate screen 序列（\x1b[?1049h/l）由调用方（app.tsx openPager）管理，紧绑 inPager 状态；
// 本模块只管「把 content 喂给 less 并等它退出」。
// less 不存在 / spawn 失败 → reject（调用方 try/catch 兜底切回主屏 + 提示）。
// 详见 docs/20260806230000_工具折叠-详设.md §5.3。
import { spawn } from 'node:child_process';

/** less 底部提示文案（-P 参数）。 */
const LESS_PROMPT = '转录视图 · /搜索 · ↑↓滚动 · q退出';

/**
 * 用 less 查看 content：-R 解析 ANSI 颜色、--no-init 避免进出场闪烁；
 * content 经 stdin pipe 喂入；等用户 q 退出（child exit）resolve。
 * @param prompt less 底部提示文案（-P），默认 LESS_PROMPT
 */
export function runLess(content: string, prompt: string = LESS_PROMPT): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('less', ['-R', '--no-init', '-P', prompt], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('exit', resolve);
    child.on('error', reject); // less 不存在 / spawn 失败
    child.stdin.write(content);
    child.stdin.end();
  });
}
