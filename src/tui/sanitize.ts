/**
 * 不可信内容净化（F-47，方案 A 批 0 前置门）。
 *
 * 面板（子代理 transcript / 后台任务日志 / 工具全文）渲染的内容来源不可信：
 * bash 输出、被读文件、LLM 文本、MCP 返回，都可能内嵌终端转义序列。alt-screen
 * 全屏化后「终端内容即 UI」，注入后果升级（1049l 逃逸伪造主界面 / OSC 0 改标题
 * 钓鱼 / OSC 52 静默覆写剪贴板 / 光标序列重画伪造审批卡）。
 *
 * 与 Ink 内置净化层（squash-text-nodes → sanitize-ansi）的关系：Ink 7.1.1 意外
 * 兜住 CSI 级（含 1049/2J/光标移动），但 OSC 全家族**特意保留**、裸 C0 透传，且该
 * 层是 Ink 内部实现非公开契约（^7.1.1 允许漂移）。本模块是显式第一线，Ink 净化
 * 降级为纵深二线。
 *
 * 白名单策略（查看全文是阅读场景）：
 *   剥——C0 控制（仅留 \n，\t 展开空格）、C1（U+0080–009F）、全部 CSI、全部 OSC、
 *        DCS/PM/APC/SOS、ESC 单字符序列（RIS/保存光标等）、孤立 ESC（未终结序列
 *        自 ESC 起整段丢弃，与 Ink tokenizer 同策略——truncate 劈序列是安全方向）；
 *   留——普通文本与换行。
 * 一期全剥 SGR（黑白阅读基调，与 CC transcript 同）：面板 chrome 由 ECode 渲染，
 * 内容区着色对可读性非必要；若二期要保色，放行 `ESC[[0-9;:]*m` 即可。
 */

/** 不可信文本净化：剥全部终端转义序列与控制字符（白名单=普通文本+换行）。 */
export function stripUntrustedAnsi(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (ch !== '\x1b') {
      // 非 ESC：C0/C1 控制剥（\n 保留、\t 展开空格），其余原样
      const code = ch.charCodeAt(0)
      if (code === 0x0a) out += '\n'
      else if (code === 0x09) out += '    '
      else if (code >= 0x20 && !(code >= 0x80 && code <= 0x9f)) out += ch
      i++
      continue
    }
    // ESC 序列：按下一字节分派；未终结/不认识的序列吞到「下一个可打印字符前」
    const next = i + 1 < n ? text[i + 1]! : ''
    if (next === '[') {
      // CSI：扫描到 final(0x40-0x7e)。SGR（final 'm' 且参数仅 0-9;:，无私有前缀）放行——
      // 颜色是内容可读性的一部分（F-50 轻量 markdown），Ink 内置净化同样保留 SGR；
      // 其余 CSI（1049/1000/2J/光标移动等）全部剥
      i += 2
      let params = ''
      let finalByte = ''
      while (i < n) {
        const c = text.charCodeAt(i)
        const ch = text[i]!
        if (c >= 0x40 && c <= 0x7e) {
          finalByte = ch
          i++
          break
        }
        params += ch
        i++
      }
      if (finalByte === 'm' && /^[0-9;:]*$/.test(params)) out += `[${params}m`
      continue
    }
    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
      // OSC / DCS / PM / APC / SOS：吞到 ST(ESC \) 或 BEL 为止；无终结符=吞到串尾
      i += 2
      let terminated = false
      while (i < n) {
        if (text[i] === '\x07') {
          i++
          terminated = true
          break
        }
        if (text[i] === '\x1b' && text[i + 1] === '\\') {
          i += 2
          terminated = true
          break
        }
        i++
      }
      if (!terminated) i = n
      continue
    }
    if (next !== '') {
      // ESC 单字符序列（ESC 7/8/c/=/＞ 等）：吞 ESC+1 字节
      i += 2
      continue
    }
    // 尾部孤立 ESC：吞掉
    i++
  }
  return out
}
