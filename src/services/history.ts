/**
 * HistoryStore stub（M1）。
 *
 * M4 替换为完整 HistoryStore（增量落盘 JSONL、跨会话恢复、密钥脱敏），
 * 详设 §4.2。M1 只占接口位，append noop（主循环 finally 仍调用，保证 M4 接入零改动）。
 */

import type { Message } from '../core/types.js'

export interface HistoryStore {
  /** 增量追加一条 message（M4 落盘，M1 noop）。 */
  append(msg: Message): void
}

/** M1 stub：append noop（M4 实现真持久化）。 */
export class NoopHistoryStore implements HistoryStore {
  append(_msg: Message): void {
    // M1 stub：noop
  }
}
