// PickerList —— 通用候选列表纯展示组件（方向 A 斜杠补全 / 方向 C 会话切换共用）。
// 只渲染：候选行 + 选中高亮 + 滚动窗口 + 可选提示行。交互（useInput）由调用方处理，
// 避免独立 useInput 与调用方抢键（见 input-bar.tsx 的单一 useInput 分支设计）。
// 视觉对齐 CC：A 单行＝PromptInputFooterSuggestions；C twoLine＝LogSelector 两行制。落到 ECode token。
import React from 'react';
import { Box, Text } from 'ink';
import { T, SYMBOLS } from './theme.js';

export interface PickerItem {
  /** 主标签（A=命令名，渲染时补 prefix；C=会话标题） */
  name: string;
  description: string;
}

interface PickerListProps {
  items: PickerItem[];
  /** 当前选中项索引（调用方维护） */
  selectedIndex: number;
  /** 最多显示几条，超出滚动；默认 5（对齐 CC OVERLAY_MAX_ITEMS） */
  maxItems?: number;
  /** 底部提示行（如「↑↓ 选择 · enter 执行 · esc 取消」） */
  hint?: string;
  /** name 前缀（A 命令补 '/'；C 会话标题传 ''）。默认 '/'（保持 A 行为不变）。 */
  prefix?: string;
  /** 两行制（C 会话：name 行 + description 独立 dim 行，对齐 CC LogSelector）。默认 false（A 单行）。 */
  twoLine?: boolean;
}

/** 滚动窗口起始索引：选中项尽量保持视窗中部，clamp 到合法范围。 */
function windowStart(selectedIndex: number, len: number, maxItems: number): number {
  if (len <= maxItems) return 0;
  const ideal = selectedIndex - Math.floor(maxItems / 2);
  return Math.max(0, Math.min(ideal, len - maxItems));
}

export function PickerList({
  items,
  selectedIndex,
  maxItems = 5,
  hint,
  prefix = '/',
  twoLine = false,
}: PickerListProps): React.ReactElement {
  const len = items.length;
  const cap = Math.min(maxItems, len);
  const start = windowStart(selectedIndex, len, cap);
  // 标签 = prefix + name（A 补 '/'；C prefix='' 即纯标题）。单行模式按最长标签 padEnd 对齐。
  const labels = items.map((i) => prefix + i.name);
  const nameWidth = len === 0 ? 0 : Math.max(...labels.map((l) => l.length)) + 2;

  return (
    <Box flexDirection="column">
      {items.slice(start, start + cap).map((item, i) => {
        const selected = start + i === selectedIndex;
        const label = labels[start + i];
        const indicator = selected ? `${SYMBOLS.user} ` : '  ';

        if (twoLine) {
          // 两行制（C 会话，对齐 CC LogSelector）：标题行 + metadata 独立 dim 行
          return (
            <Box key={start + i} flexDirection="column">
              <Text wrap="truncate">
                <Text color={selected ? T.accent : T.muted}>{indicator}</Text>
                <Text color={selected ? T.accent : T.suggestion}>{label}</Text>
              </Text>
              <Text color={T.muted} wrap="truncate">
                {'    '}{item.description}
              </Text>
            </Box>
          );
        }

        // 单行（A 命令）：指示符 + 标签(padEnd 对齐) + 描述
        return (
          <Text key={start + i} wrap="truncate">
            <Text color={selected ? T.accent : T.muted}>{indicator}</Text>
            <Text color={selected ? T.accent : T.suggestion}>{label.padEnd(nameWidth)}</Text>
            <Text color={selected ? T.suggestion : T.muted}>{item.description}</Text>
          </Text>
        );
      })}
      {hint !== undefined && <Text color={T.muted}>  {hint}</Text>}
    </Box>
  );
}
