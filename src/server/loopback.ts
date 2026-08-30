/**
 * M12-B7：loopback 白名单（serve http/multi 共用）。
 * 逐请求 socket.remoteAddress 比对——禁信 X-Forwarded-For/X-Real-IP/Host（伪造防线，v1.2 P1-1）。
 */

/** 回环地址白名单。::ffff: 前缀是 IPv6 映射的 IPv4（Node 在双栈 socket 上报告的形态）。 */
export const LOOPBACK_ADDRS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 绑定地址是否回环（启动期判定一次；与 listen host 字符串口径一致）。 */
export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * 逐请求来源门（抽纯函数导出供单测——集成测试无法伪造非回环 remoteAddress，M13-W3 起
 * 此路径零覆盖；2026-08-30 真机实证 multi 硬编码白名单导致 LAN 绑定 + lan-password 全链失效）。
 *
 * 语义：
 * - 绑定回环（默认）：非白名单来源一律 403——单机部署的原有防线不变；
 * - 绑定 0.0.0.0/具体 IP（serve 已在启动期强制 lan-password 凭据，multi.ts M13-W3）：
 *   来源放行交由 Bearer 鉴权（token/密码两等凭据）裁决——loopback 白名单只该守"只打算
 *   给本机用"的部署，不应把显式开给局域网、设了密码的端口也一并锁死。
 *
 * IPv6 区带（fe80::/10、fc00::/7）与 ::ffff: 映射的非回环 IPv4 视为非本机来源——按
 * remoteAddress 原样白名单比对，不做区带推断（转发/代理场景语义复杂化，等 R 线配对体系）。
 */
export function remoteDenied(remote: string, boundLoopback: boolean): boolean {
  if (!boundLoopback) return false
  return !LOOPBACK_ADDRS.has(remote)
}
