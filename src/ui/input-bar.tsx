// InputBar —— 单行输入 + ↑↓ 历史（spec §5.3 / §8.4）。
// 不用 ink-multiline-input（不成熟，实施方案明确排除）。L2 自研单行。
// Tab 补全由 App 层处理（suggestions prop 透传），InputBar 只负责文本 + 历史。
import React, { useState, useReducer } from 'react';
import { Text, Box, useInput } from 'ink';
import { T, SYMBOLS } from './theme.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

interface HistoryState {
  items: string[]; // 已提交的历史
  index: number; // -1 = 当前草稿（不在历史中浏览）
  draft: string; // 翻历史前的草稿
}

type HistoryAction =
  | { type: 'push'; text: string }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'setDraft'; text: string };

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'push':
      return { items: [...state.items, action.text], index: -1, draft: '' };
    case 'up': {
      if (state.items.length === 0) return state;
      const next = state.index === -1 ? state.items.length - 1 : Math.max(0, state.index - 1);
      return { ...state, index: next };
    }
    case 'down': {
      if (state.index === -1) return state;
      const next = state.index + 1;
      if (next > state.items.length - 1) return { ...state, index: -1 };
      return { ...state, index: next };
    }
    case 'setDraft':
      return state.index === -1 ? { ...state, draft: action.text } : state;
  }
}

export function InputBar({ onSubmit, disabled = false }: InputBarProps): React.ReactElement {
  const [text, setText] = useState('');
  const [hist, dispatch] = useReducer(historyReducer, { items: [], index: -1, draft: '' });

  useInput((input, key) => {
    if (disabled) return;
    if (key.upArrow) {
      dispatch({ type: 'setDraft', text });
      dispatch({ type: 'up' });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: 'down' });
      return;
    }
    if (key.return) {
      const trimmed = text.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      dispatch({ type: 'push', text: trimmed });
      setText('');
      return;
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      return;
    }
    // 普通字符（过滤控制字符）
    if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 0x20) {
      setText((t) => t + input);
    }
  });

  // 历史浏览时显示历史项，否则显示当前输入
  const displayed = hist.index === -1 ? text : hist.items[hist.index] ?? '';

  if (disabled) {
    return (
      <Text color={T.warning}>
        {SYMBOLS.warning} running · {''}
        <Text color={T.muted}>esc to interrupt</Text>
      </Text>
    );
  }

  return (
    <Box>
      <Text color={T.user}>{SYMBOLS.user} </Text>
      <Text>{displayed}</Text>
      <Text color={T.muted}>_</Text>
    </Box>
  );
}
