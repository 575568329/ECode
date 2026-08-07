// ModelPicker —— /model 模型选择器（D1，照搬 SessionPicker 模板）。
// Modal 形态（App 用三元前置 modelOpen 替换 InputBar），自带 useInput：
//   ↑↓ 循环导航（首项↑跳末项，对齐 CC use-select-navigation）/ Enter 切换 / Esc 取消。
// 复用 PickerList（twoLine 两行制）。列表项：name=model 名 / description=provider。
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { T } from './theme.js';
import { PickerList, type PickerItem } from './picker-list.js';

interface ModelPickerProps {
  /** 可选模型列表（App 层已过滤当前模型，且非空）。 */
  options: PickerItem[];
  /** 选中项的 name（model 名）→ App 切 model。 */
  onConfirm: (modelName: string) => void;
  onCancel: () => void;
}

const PICKER_MAX_ITEMS = 6;

export function ModelPicker({ options, onConfirm, onCancel }: ModelPickerProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const len = options.length;

  // 选项变化（重开 picker）→ 选中重置首项
  useEffect(() => {
    setIndex(0);
  }, [options]);

  // clamp 防越界（options 变少时兜底）
  const safeIndex = len === 0 ? 0 : Math.min(index, len - 1);

  useInput((_input, key) => {
    if (len === 0) return;
    if (key.upArrow) {
      setIndex((i) => (i - 1 + len) % len); // 循环：首项↑跳末项（对齐 CC）
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % len);
      return;
    }
    if (key.return) {
      onConfirm(options[safeIndex].name);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={T.muted}>切换模型{len > PICKER_MAX_ITEMS ? `（共 ${len} 个）` : ''}</Text>
      <PickerList
        items={options}
        selectedIndex={safeIndex}
        maxItems={PICKER_MAX_ITEMS}
        prefix=""
        twoLine
        hint="↑↓ 选择 · enter 切换 · esc 取消"
      />
    </Box>
  );
}
