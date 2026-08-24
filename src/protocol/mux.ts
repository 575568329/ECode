/**
 * M13-W2 mux 协议层：MuxFrame 信封 + HostEvent 生命周期帧（方案 §3.2/§3.3）。
 *
 * 设计（Q2 决策）：**信封包装，内层 27 事件枚举零改动**——单项目端点
 * `/api/p/<path>/events` 保持裸 ProtocolEvent（调试端点）；mux 端点（W3）广播信封帧。
 * HostEvent 为独立联合（与 ProtocolEvent 不交）：mux 专属，所需字段自带帧体内，
 * 不占信封 sessionId 字段（信封 sessionId 只用于 ProtocolEvent 分发）。
 */

import type { ProtocolEvent } from './types.js'

/** 会话摘要（session/baseline 与 session/created 帧体） */
export interface SessionBrief {
  project: string
  sessionId: string
  running: boolean
  /** 首条 user 消息截断（列表展示用；冷会话来自 meta.firstUser） */
  title: string
  updatedAt: number
}

/** mux 专属生命周期帧（独立联合——项目/会话增删与连接基线；单项目端点不发） */
export type HostEvent =
  | { type: 'project/added'; project: string }
  | { type: 'project/removed'; project: string }
  | { type: 'session/created'; brief: SessionBrief }
  | { type: 'session/removed'; project: string; sessionId: string }
  /** 连接建立时的全量基线（活项目+活会话清单——前端初始列表免 REST） */
  | { type: 'session/baseline'; projects: string[]; sessions: SessionBrief[] }

/** mux 信封帧：内层事件带 project/sessionId 维度；HostEvent 自带所需字段 */
export type MuxFrame =
  | { project: string; sessionId: string; ev: ProtocolEvent }
  | { host: HostEvent }

/** cmd 请求信封（POST body；W2 起 multi 路由按此解——兼容裸 ProtocolCommand 过渡到 W5） */
export interface CommandEnvelope {
  sessionId?: string
  op: import('./types.js').ProtocolCommand
}
