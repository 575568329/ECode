// formatRelativeTimeAgo —— ISO 时间 → 相对时间字符串（/resume 会话列表 metadata 用）。
// 仿 CC formatRelativeTimeAgo。纯函数，now 显式传入（不依赖 Date.now()，可确定断言）。
// 阈值：<1min 刚刚 / <1h N分钟前 / <24h N小时前 / ≥24h N天前。未来时间（clock skew）按「刚刚」兜底。

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * @param isoTime ISO 8601 时间字符串（如 session.updatedAt）
 * @param now 当前时间戳（ms），由调用方传 Date.now()
 */
export function formatRelativeTimeAgo(isoTime: string, now: number): string {
  const diff = now - new Date(isoTime).getTime();
  if (diff < MIN_MS) return '刚刚'; // 含未来时间（负 diff）与小 skew
  if (diff < HOUR_MS) return `${Math.floor(diff / MIN_MS)}分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}小时前`;
  return `${Math.floor(diff / DAY_MS)}天前`;
}
