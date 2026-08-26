/**
 * hash 路由纯函数（零服务端改动——SPA 免 fallback）：#/p/<项目>[/s/<会话>]。
 * 深链/刷新/后退可用；store↔hash 双向同步（先比对防回环）。
 * App 装配 location.hash，纯函数形态供测试。
 */

export interface RoutePos {
  p: string | null
  s: string | null // null=未选会话（hero 态——输入即开新对话）
}

export function parseHash(hash: string): RoutePos {
  const m = /^#\/p\/([^/]+)(?:\/s\/([^/]+))?$/.exec(hash)
  if (m === null) return { p: null, s: null }
  // 旧链 'new' 占位已废（真新建经 session/new 立即转正实 id）——视同未选会话
  return { p: decodeURIComponent(m[1]), s: m[2] === undefined || m[2] === 'new' ? null : decodeURIComponent(m[2]) }
}

export function makeHash(pos: RoutePos): string {
  if (pos.p === null) return '#/'
  const base = `#/p/${encodeURIComponent(pos.p)}`
  return pos.s === null ? base : `${base}/s/${encodeURIComponent(pos.s)}`
}
