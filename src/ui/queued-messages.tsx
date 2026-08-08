// QueuedMessages —— 排队预览：待处理 user 消息灰显（消息队列与交互重做方案 §4.2）。
// 位置：InputBar 正上方（ChatView 与交互区之间）。数据源 = controller.pendingQueue 镜像（hook queuedMessages）。
//
// 不双显（§4.2 P0）：user submit 进 queuedMessages（此处，灰显）；runLoop 出队时移出此处、
// 进 completedMessages（正式 user 气泡）。同一消息任一时刻只在一处。
//
// 提交即时出现 = 强反馈（对抗"消息没发出去"困惑）：用户 submit → 此处立刻出现该条灰显 +
// StatusBar 持续显示"待处理:N"。无需额外闪现 state。
import React from 'react';
import { Text, Box } from 'ink';
import { T, SYMBOLS } from './theme.js';

interface QueuedMessagesProps {
  messages: string[];
}

export function QueuedMessages({ messages }: QueuedMessagesProps): React.ReactElement | null {
  if (messages.length === 0) return null; // 空 → 不渲染（不占位）
  // key 用 index：排队消息是临时消费列表（shift 出队），无稳定 id；纯展示无内部状态，index 安全。
  return (
    <Box flexDirection="column">
      {messages.map((text, i) => (
        <Box key={i}>
          <Text color={T.muted}>{SYMBOLS.user} </Text>
          <Text color={T.muted}>{text}</Text>
        </Box>
      ))}
    </Box>
  );
}
