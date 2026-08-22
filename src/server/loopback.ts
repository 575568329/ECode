/**
 * M12-B7：loopback 白名单（serve http/multi 共用）。
 * 逐请求 socket.remoteAddress 比对——禁信 X-Forwarded-For/X-Real-IP/Host（伪造防线，v1.2 P1-1）。
 */
export const LOOPBACK_ADDRS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
