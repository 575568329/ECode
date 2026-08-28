/**
 * F-05：jsdiff createTwoFilesPatch 对非 ASCII 文件名生成 `"\350\257\246..."` 八进制转义
 * header（UTF-8 字节 → \NNN），且新版 jsdiff 缺省 timestamp 对象会打出 `[object Object]` 尾巴。
 * 此处生成后统一修复：---/+++ 两行 header 还原可读文件名 + 去掉 `[object Object]`。
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

/** 修 diff header：还原中文文件名 + 去 `[object Object]`（jsdiff timestamp bug 尾巴）。 */
export function fixPatchHeaders(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      if (!line.startsWith('--- ') && !line.startsWith('+++ ')) return line
      let out = line
      if (out.includes('[object Object]')) {
        out = out.replace(/\s*\[object Object\]\s*$/, '')
      }
      // `--- "\350\257\246.md"` 形态：去引号 + 八进制解码
      out = out.replace(/^(\+\+\+|---) "((?:\\.|[^"\\])*)"/, (_m, prefix, body: string) => {
        return `${prefix} ${decodeOctalEscapes(body).replace(/\\/g, '\\\\')}`
      })
      return out
    })
    .join('\n')
}
