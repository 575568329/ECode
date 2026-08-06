// 终端字符显示宽度（Unicode East Asian Width，UAX #11 的宽字符高频区间）。
// Why：表格列对齐用 padEnd 按 string.length 算列宽，但中文 length=2 占 2 个终端列，
//   padEnd 误判已满不补 → 该列右侧所有 │ 右移错位。padEnd 必须按「显示宽度」补空格。
// 范围取高频区间（非全集），覆盖 CJK/全角/假名/谚文；几何符号（❯◆▸↳✓）保持 1 宽
//   （theme 单宽设计），不在下方 wide 区间内 → 正确返回 1。

/** 宽字符（显示占 2 列）的 Unicode 区间。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK 部首 + 标点
  [0x3041, 0x33ff], // 假名 + CJK 符号
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK 统一表意文字（常用汉字）
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII（含全角冒号：/全角括号（））
  [0xffe0, 0xffe6], // 全角符号
  [0x20000, 0x2fffd], // CJK Ext B+（surrogate pair，codePointAt 自动合并高低代理项）
  [0x30000, 0x3fffd], // CJK Ext C+
];

function charWidth(code: number): number {
  for (const [lo, hi] of WIDE_RANGES) {
    if (code >= lo && code <= hi) return 2;
  }
  return 1;
}

/** 字符串在终端的显示宽度（CJK/全角=2，ASCII/半角=1）。 */
export function displayWidth(str: string): number {
  let width = 0;
  // codePointAt 遍历：正确合并 surrogate pair（CJK Ext B+ 在 U+20000 以上需 2 个 UTF-16 码元）。
  for (let i = 0; i < str.length; ) {
    const code = str.codePointAt(i)!; // i < length 保证非 undefined
    width += charWidth(code);
    i += code > 0xffff ? 2 : 1; // 跳过低代理项
  }
  return width;
}

/** 按显示宽度右侧补空格（padEnd 的显示宽度版：中文按 2 列计，不会补错）。 */
export function padEndDisplay(str: string, targetWidth: number): string {
  const pad = targetWidth - displayWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}
