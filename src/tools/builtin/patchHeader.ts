/**
 * F-05：jsdiff createTwoFilesPatch 对非 ASCII 文件名生成 `"\350\257\246..."` 八进制转义
 * header（UTF-8 字节 → \NNN），且新版 jsdiff 缺省 timestamp 对象会打出 `[object Object]` 尾巴。
 * 此处生成后统一修复：---/+++ 两行 header 还原可读文件名 + 去掉 `[object Object]`。
 * F-43：顺带裁掉 `Index:` / `=====` 冗余行（jsdiff 的 svn 风格头，git diff 无此二行；
 * 工具行已显示文件路径，diff 头重复且 Windows 绝对路径占满一行）。
 */

/** 解码 header 引号串里的 \NNN 八进制序列为原字符（jsdiff 转义形态：UTF-8 字节逐个八进制）。 */
function decodeOctalEscapes(s: string): string {
  return s.replace(/(?:\\[0-7]{1,3})+/g, (seq) => {
    const bytes: number[] = []
    for (const m of seq.matchAll(/\\([0-7]{1,3})/g)) bytes.push(parseInt(m[1], 8))
    // 字节序列按 UTF-8 解回字符串；非法序列兜底原样返回
    try {
      const dec = new TextDecoder('utf-8', { fatal: true })
      return dec.decode(new Uint8Array(bytes))
    } catch {
      return seq
    }
  })
}

/** 修 diff header：还原中文文件名 + 去 `[object Object]`（jsdiff timestamp bug 尾巴），
 *  并裁掉 Index/===== 冗余行。 */
export function fixPatchHeaders(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('Index: ') && line !== '===================================================================')
    .map((line) => {
      if (!line.startsWith('--- ') && !line.startsWith('+++ ')) return line
      let out = line
      if (out.includes('[object Object]')) {
        out = out.replace(/\s*\[object Object\]\s*$/, '')
      }
      // `--- "\350\257\246.md"` 形态：去引号 + 八进制解码。
      // F-43：解码结果原样输出——此前 `.replace(/\\/g, '\\\\')` 会把 Windows 路径的
      // 反斜杠翻倍（D:\xunfei → D:\\xunfei，终端复制/再转义后看到 4 个），纯损害。
      out = out.replace(/^(\+\+\+|---) "((?:\\.|[^"\\])*)"/, (_m, prefix, body: string) => {
        return `${prefix} ${decodeOctalEscapes(body)}`
      })
      return out
    })
    .join('\n')
}
