// InputBar —— 单行输入 + ↑↓ 历史（spec §5.3 / §8.4）+ 斜杠命令 picker（方向 A）。
// 不用 ink-multiline-input（不成熟，实施方案明确排除）。L2 自研单行。
//
// picker 设计（方向 A 详设 docs/详设/20260806180000_斜杠命令补全-详设.md）：
//   - / 开头 + 无空格 → 前缀匹配 SLASH_COMMANDS 显示候选；↑↓ 选中、Enter 直接执行、Esc 关闭。
//   - 单一 useInput 分支（picker 态 / 非 picker 态），picker 不用独立 useInput，避免抢键。
//   - 对齐 CC：去 Tab（选中即 Enter 执行，最短路径）；Esc 关 picker（与「中断流」状态互斥不冲突——
//     app.tsx:66 中断流仅 isRunning 触发，picker 只 idle 出现）。
import React, { useState, useReducer, useMemo, useEffect, useRef } from 'react';
import { Text, Box, useInput } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { PickerList, type PickerItem } from './picker-list.js';
import { SLASH_COMMANDS } from '../slash-commands.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
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
  | { type: 'setDraft'; text: string }
  | { type: 'reset' };

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
    case 'reset':
      // 双击 Esc 清空：保留已提交历史（items），回到当前草稿态（index=-1）。
      return { ...state, index: -1, draft: '' };
  }
}

/** picker 显示的最多候选条数（对齐 CC OVERLAY_MAX_ITEMS，超出滚动）。 */
const PICKER_MAX_ITEMS = 5;
/** 双击 Esc 判定窗口（ms）：窗口内第二次 Esc → 清空输入框。单击 Esc 仅记时间、无操作。 */
const DOUBLE_ESC_MS = 500;

export function InputBar({ onSubmit }: InputBarProps): React.ReactElement {
  const [text, setText] = useState('');
  const [hist, dispatch] = useReducer(historyReducer, { items: [], index: -1, draft: '' });
  const [pickerIndex, setPickerIndex] = useState(0);
  // Esc 关 picker 后置位；继续编辑（字符/backspace）复位，使 picker 可重显。text 保留。
  const [pickerDismissed, setPickerDismissed] = useState(false);
  // 双击 Esc 清空输入框：ref 记上次 Esc 时间（ref 即时判双击，不触发重绘；清空走 setText 才重绘）。
  const lastEscRef = useRef(0);

  // 候选（派生）：/ 开头 + 无空格（带参不提示，对齐 CC hasCommandArgs）→ 前缀匹配。
  // useMemo 稳定引用：text 不变则 candidates 不变 → ↑↓ 改 pickerIndex 不会触发 reset effect。
  const candidates: PickerItem[] = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ')) return [];
    const query = text.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(query))
      .map((c) => ({ name: c.name, description: c.description }));
  }, [text]);

  const pickerVisible = candidates.length > 0 && !pickerDismissed;

  // 候选变化（即 text 变）→ 选中重置第一项。↑↓ 只改 pickerIndex 不改 text → 不触发 → 选中保持。
  useEffect(() => {
    setPickerIndex(0);
  }, [candidates]);

  // 选中兜底：候选变少时 clamp 防越界。
  const safeIndex = candidates.length === 0 ? 0 : Math.min(pickerIndex, candidates.length - 1);

  useInput((input, key) => {
    if (pickerVisible) {
      // picker 活跃：↑↓ 导航、Enter 直接执行、Esc 关闭；字符/backspace 落共用段继续编辑。
      if (key.upArrow) {
        setPickerIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (key.downArrow) {
        setPickerIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (key.return) {
        const name = candidates[safeIndex].name;
        onSubmit('/' + name);
        dispatch({ type: 'push', text: '/' + name });
        setText('');
        return;
      }
      if (key.escape) {
        setPickerDismissed(true);
        return;
      }
    } else {
      // 非 picker：Esc 双击清空 + 历史导航 + 提交。
      if (key.escape) {
        // 双击 Esc（DOUBLE_ESC_MS 内第二次）→ 清空输入框；单击仅记时间，无操作。
        const now = Date.now();
        if (now - lastEscRef.current < DOUBLE_ESC_MS) {
          setText('');
          dispatch({ type: 'reset' }); // 清当前输入 + 回到草稿态（浏览历史时也回到空白）
        }
        lastEscRef.current = now;
        return;
      }
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
    }

    // 共用：backspace + 字符（picker 与非 picker 都要编辑文本；编辑即复位 pickerDismissed）。
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      setPickerDismissed(false);
      return;
    }
    if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 0x20) {
      setText((t) => t + input);
      setPickerDismissed(false);
    }
  });

  // 历史浏览时显示历史项，否则当前输入。
  const displayed = hist.index === -1 ? text : hist.items[hist.index] ?? '';

  return (
    <Box flexDirection="column">
      {pickerVisible && (
        <PickerList
          items={candidates}
          selectedIndex={safeIndex}
          maxItems={PICKER_MAX_ITEMS}
          hint="↑↓ 选择 · enter 执行 · esc 取消"
        />
      )}
      <Box>
        <Text color={T.user}>{SYMBOLS.user} </Text>
        <Text>{displayed}</Text>
        <Text color={T.muted}>_</Text>
      </Box>
    </Box>
  );
}
