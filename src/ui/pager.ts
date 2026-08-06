// pager —— 封装 less pager 调用（spawn + stdin pipe）。
// alternate screen 序列（\x1b[?1049h/l）由调用方（app.tsx openPager）管理，紧绑 inPager 状态；
// 本模块只管「把 content 喂给 less 并等它退出」。
// less 不存在 / spawn 失败 → reject（调用方 try/catch 兜底切回主屏 + 提示）。
// 详见 docs/20260806230000_工具折叠-详设.md §5.3。
import { spawn } from 'node:child_process';

/** less 底部提示文案（-P 参数）。
 *  less inherit stdio 独占按键 —— app 的 useInput 在 pager 期间让位，收不到 esc；less 本身只认 q 退出。
 *  故无法支持 esc 退出，只能靠提示把「按 q 退出」放最前最醒目（问题 G）。 */
const LESS_PROMPT = '[ 按 q 退出 ]  转录视图 · / 搜索文本 · ↑↓ 滚动';

/**
 * 用 less 查看 content：-R 解析 ANSI 颜色、--no-init 避免进出场闪烁；
 * content 经 stdin pipe 喂入；等用户 q 退出（child exit）resolve。
 * @param prompt less 底部提示文案（-P），默认 LESS_PROMPT
 */
export function runLess(content: string, prompt: string = LESS_PROMPT): Promise<void> {
  return new Promise((resolve, reject) => {
    // -Q（completely quiet）：never ring terminal bell。-q（--quiet）只是 moderately quiet，Windows
    // less.exe 翻到边界仍会发 \a → 映射 Windows「默认提示音」响铃（git diff 翻页同款问题）。
    // -Q 彻底静默。来源：stackoverflow/q/1266545 + less man（-Q / --QUIET）。
    const child = spawn('less', ['-R', '--no-init', '-Q', '-P', prompt], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('exit', resolve);
    child.on('error', reject); // less 不存在 / spawn 失败
    child.stdin.write(content);
    child.stdin.end();
  });
}
