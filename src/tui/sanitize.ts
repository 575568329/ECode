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
 *   剥——C0 控制（仅留 \n，\t 展开空格）、C1（U+0080–009F）、除 SGR 外全部 CSI、全部 OSC、
 *        DCS/PM/APC/SOS、ESC 单字符序列（RIS/保存光标等）、孤立 ESC（未终结序列
 *        自 ESC 起整段丢弃，与 Ink tokenizer 同策略——truncate 劈序列是安全方向）；
 *   留——普通文本与换行。
 * F-50b 修订（四角色审阅 P2 注释漂移修正）：SGR 放行（final 'm' 且参数仅 0-9;:，无私有
 * 前缀）——粗体/行内代码着色是内容可读性的一部分（mdInline 轻格式依赖），Ink 内置净化
 * 同样保留 SGR；其余 CSI 一律剥。
 */

/** 不可信文本净化：剥全部终端转义序列与控制字符（白名单=普通文本+换行）。 */
export function stripUntrustedAnsi(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (ch !== '\x1b') {
      // 非 ESC：C0/C1 控制剥（\n 保留、\t 展开空格、DEL 0x7f 剥——审阅项 2），其余原样
      const code = ch.charCodeAt(0)
      if (code === 0x0a) out += '\n'
      else if (code === 0x09) out += '    '
      else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += ch
      i++
      continue
    }
    // ESC 序列：按下一字节分派；未终结/不认识的序列吞到「下一个可打印字符前」
    const next = i + 1 < n ? text[i + 1]! : ''
    if (next === '[') {
      // CSI：扫描到 final(0x40-0x7e)。SGR（final 'm' 且参数仅 0-9;:，无私有前缀）放行——
      // 颜色是内容可读性的一部分（F-50 轻量 markdown），Ink 内置净化同样保留 SGR；
      // 其余 CSI（1049/1000/2J/光标移动等）全部剥。
      // 审阅项 2：参数扫描加 64 字节上限——截断的 CSI（无 final）原实现吞到串尾，
      // 攻击者可用它把后续正文整段「化妆性删除」；超限按垃圾吞掉已扫部分继续。
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
        if (params.length >= 64) {
          finalByte = ''
          break
        }
        params += ch
        i++
      }
      if (finalByte === 'm' && /^[0-9;:]*$/.test(params)) out += '\x1b[' + params + 'm'
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
    if (next >= '\x20' && next <= '\x2f') {
      // 审阅项 2：ESC + 中间字节序列（ESC ( B 字符集指定 / ESC % G 编码等）——
      // 原实现只吞 2 字节，final 落为正文残留。吞 ESC+全部中间字节+1 个 final
      i += 2
      while (i < n && text[i]! >= '\x20' && text[i]! <= '\x2f') i++
      if (i < n) i++
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

/** pending 积压上限（恶意无终结 OSC 的跨 chunk 内存防线）：超限强制按丢弃 flush */
const STRIPPER_PENDING_CAP = 8192

/** 尾段（以 ESC 开头）是否已构成完整序列——stripper 判定「留在 pending 等下一块」用 */
function escapeComplete(tail: string): boolean {
  const next = tail.length > 1 ? tail[1]! : ''
  if (next === '[') {
    // CSI：前 64 字节内出现 final 即完整
    for (let i = 2; i < tail.length && i < 66; i++) {
      const c = tail.charCodeAt(i)
      if (c >= 0x40 && c <= 0x7e) return true
    }
    return false
  }
  if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
    // OSC/DCS 族：出现 BEL 或 ESC\ 即完整
    return /(\x07|\x1b\\)/.test(tail)
  }
  if (next >= '\x20' && next <= '\x2f') {
    // 中间字节序列：出现 final（0x30-0x7e）即完整
    for (let i = 2; i < tail.length; i++) {
      const c = tail.charCodeAt(i)
      if (c >= 0x30 && c <= 0x7e) return true
    }
    return false
  }
  return tail.length >= 2 // ESC 单字符序列
}

/**
 * 可恢复净化器（项 1，流式接入）：转义序列可能被 delta 切成两半（'[' 在上一块、
 * 'm' 在下一块）——每次 push 把尾部疑似半截序列扣留在 pending，与下一块拼接后处理。
 * 输出语义与 stripUntrustedAnsi 完全一致（含 SGR 放行），另保证拼接路径下跨块序列
 * 同样被正确剥除/放行。恶意积压防线：pending 超 8KB 强制丢弃。
 */
export function createAnsiStripper(): { push(chunk: string): string } {
  let pending = ''
  return {
    push(chunk: string): string {
      let text = pending + chunk
      pending = ''
      const lastEsc = text.lastIndexOf('\x1b')
      if (lastEsc >= 0) {
        const tail = text.slice(lastEsc)
        if (!escapeComplete(tail)) {
          text = text.slice(0, lastEsc)
          if (tail.length <= STRIPPER_PENDING_CAP) pending = tail
        }
      }
      return stripUntrustedAnsi(text)
    },
  }
}
