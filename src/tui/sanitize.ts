/**
 * 不可信内容净化——B2 起实现上移 `src/protocol/sanitize.ts`（宿主 digest 生成侧与 TUI 渲染侧
 * 单源共用）；本文件保留 re-export 薄壳，仓内既有 `./sanitize.js` import 路径零改动。
 */
export { stripUntrustedAnsi, createAnsiStripper } from '../protocol/sanitize.js'
