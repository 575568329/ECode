// 会话展示用的格式化纯函数（UI 层）。
// 数据层 session.ts 只管读写持久化，不掺展示格式；时间格式化在 format-time.ts，id 短显在此。
// 放 UI 层而非 session.ts 的另一原因：session.js 在 UI 测试里被 vi.mock 整替，
// 放此处不被 mock，测试零成本直接用真实实现。

/** 会话短标识展示长度：UUID 前 8 位。
 * 取前 8 的理由：碰撞概率 ~1/43亿，列表内足够唯一；短、不喧宾夺主；
 * 且与 --resume <id> / .ecode/sessions/ 文件名前缀对齐，便于人眼定位文件。 */
const SESSION_ID_SHORT_LENGTH = 8;

/** 取会话 id 的短展示形式（UUID 前 8 位）。供 /resume 选择器、/sessions 列表等区分同名会话。 */
export function shortSessionId(id: string): string {
  return id.slice(0, SESSION_ID_SHORT_LENGTH);
}
