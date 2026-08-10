// InputBar —— 多行输入 + cursor 编辑 + ↑↓ 历史 + 斜杠 picker
// （spec §5.3 / §8.4 / 多行输入详设 docs/详设/20260808150000）。
//
// 多行模型：text + cursor（线性 codepoint offset），所有编辑以 cursor 为锚点。
// 换行键全接（详设 §3.3）：
//   - Ctrl+Enter ：非 Kitty 终端发 \n(LF) → ink 解析为 {name:'enter'}，拦 input==='\n' 插换行
//                  Kitty 终端发 \x1b[13;5u → {return, ctrl:true}（全平台通用，Windows 首选）
//   - Shift+Enter：Kitty 协议 \x1b[13;2u → ink 7 原生解析为 {return, shift:true}（详设 §2）
//   - 反斜杠续行：行尾 \ + 裸 Enter → 删 \ 插 \n（全平台兜底，不依赖终端协议）
//
// picker（方向 A 详设 docs/20260806180000）：/ 开头 + 无空格 + 无换行 → 前缀匹配候选；
// ↑↓ 选中、Enter 执行、Esc 关闭。picker 可见 ⟹ 单行，与多行互斥。
import React, { useState, useReducer, useMemo, useEffect, useRef } from 'react';
import { Text, Box, useInput } from 'ink';
import { T, SYMBOLS } from './theme.js';
import { PickerList, type PickerItem } from './picker-list.js';
import { SLASH_COMMANDS } from '../slash-commands.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  /** 回填文本（中断撤回用）：draftVersion 递增时填入输入框（草稿态，cursor 落末尾）。
   *  用 controlled prop + 版本信号替代 ref 命令式回填——React 19 + ink 7 下 forwardRef 破坏 useInput。 */
  draftText?: string;
  /** 回填信号：递增触发回填（版本号避免相同文本重复触发；undefined/0 不触发）。 */
  draftVersion?: number;
}

interface EditState {
  text: string;
  cursor: number; // [0..text.length]，线性 codepoint offset
}

interface HistoryState {
  items: string[]; // 已提交历史
  index: number; // -1 = 草稿（不在历史中浏览）
  draft: EditState; // 翻历史前保存的草稿（含 cursor）
}

type HistoryAction =
  | { type: 'push'; text: string }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'setDraft'; draft: EditState }
  | { type: 'reset' };

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'push':
      return { items: [...state.items, action.text], index: -1, draft: { text: '', cursor: 0 } };
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
      return state.index === -1 ? { ...state, draft: action.draft } : state;
    case 'reset':
      // 双击 Esc 清空：保留已提交历史（items），回到空白草稿。
      return { ...state, index: -1, draft: { text: '', cursor: 0 } };
  }
}

// ---- cursor 行列计算（纯函数，多行编辑核心，便于推理与测试）----

/** cursor 是否在首行（前面无 \n）→ 决定 ↑ 是否翻历史。 */
function isOnFirstLine(text: string, cursor: number): boolean {
  return !text.slice(0, cursor).includes('\n');
}
/** cursor 是否在末行（后面无 \n）→ 决定 ↓ 是否翻历史。 */
function isOnLastLine(text: string, cursor: number): boolean {
  return !text.slice(cursor).includes('\n');
}
/** cursor 当前列号（行内偏移）。 */
function currentCol(text: string, cursor: number): number {
  const lastNl = text.slice(0, cursor).lastIndexOf('\n');
  return lastNl === -1 ? cursor : cursor - lastNl - 1;
}
/** 当前行起始 offset（行首 \n 之后或 0）。 */
function lineStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && text[i - 1] !== '\n') i--;
  return i;
}
/** 当前行结束 offset（指向下一个 \n 或 text.length）。 */
function lineEnd(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}
/** 上移一行同列（首行则不变，由调用方转去翻历史）。 */
function moveUp(text: string, cursor: number): number {
  const before = text.slice(0, cursor);
  const lastNl = before.lastIndexOf('\n');
  if (lastNl === -1) return cursor; // 首行
  const col = cursor - lastNl - 1;
  const prevBefore = before.slice(0, lastNl);
  const prevNl = prevBefore.lastIndexOf('\n');
  const prevStart = prevNl === -1 ? 0 : prevNl + 1;
  const prevLen = lastNl - prevStart;
  return prevStart + Math.min(col, prevLen);
}
/** 下移一行同列（末行则不变，由调用方转去翻历史）。 */
function moveDown(text: string, cursor: number): number {
  const col = currentCol(text, cursor);
  const after = text.slice(cursor);
  const nlRel = after.indexOf('\n');
  if (nlRel === -1) return cursor; // 末行
  const nextStart = cursor + nlRel + 1;
  const nextAfter = text.slice(nextStart);
  const nextNlRel = nextAfter.indexOf('\n');
  const nextLen = nextNlRel === -1 ? text.length - nextStart : nextNlRel;
  return nextStart + Math.min(col, nextLen);
}

/** picker 显示的最多候选条数（对齐 CC OVERLAY_MAX_ITEMS，超出滚动）。 */
const PICKER_MAX_ITEMS = 5;
/** 双击 Esc 判定窗口（ms）。 */
const DOUBLE_ESC_MS = 500;
/** 多行输入框最大显示行数（超出按 cursor 窗口滚动，抄 opencode 下限，防顶掉对话历史区）。 */
const INPUT_MAX_HEIGHT = 6;

export function InputBar({ onSubmit, draftText, draftVersion }: InputBarProps): React.ReactElement {
  const [edit, setEdit] = useState<EditState>({ text: '', cursor: 0 });
  const [hist, dispatch] = useReducer(historyReducer, {
    items: [],
    index: -1,
    draft: { text: '', cursor: 0 },
  });
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const lastEscRef = useRef(0);
  // 回填信号（中断撤回）：draftVersion 递增 → 回草稿态 + 填入 draftText（controlled prop 替代 ref，
  //   forwardRef 在 React 19 + ink 7 下破坏 useInput 按键提交，见 InputBarProps.draftText 注释）。
  const lastDraftVersionRef = useRef(0);
  useEffect(() => {
    if (draftVersion === undefined || draftVersion <= lastDraftVersionRef.current) return;
    lastDraftVersionRef.current = draftVersion;
    dispatch({ type: 'reset' }); // 回草稿态（index=-1 不翻历史；保留已提交 items）
    setEdit({ text: draftText ?? '', cursor: (draftText ?? '').length });
  }, [draftVersion, draftText]);

  // 候选（派生）：/ 开头 + 无空格 + 无换行 → picker 与多行互斥。
  const candidates: PickerItem[] = useMemo(() => {
    if (!edit.text.startsWith('/') || edit.text.includes(' ') || edit.text.includes('\n')) return [];
    const query = edit.text.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(query))
      .map((c) => ({ name: c.name, description: c.description }));
  }, [edit.text]);

  const pickerVisible = candidates.length > 0 && !pickerDismissed;

  useEffect(() => {
    setPickerIndex(0);
  }, [candidates]);

  const safeIndex = candidates.length === 0 ? 0 : Math.min(pickerIndex, candidates.length - 1);

  // ---- 编辑操作（cursor 锚点；text+cursor 在同一 setState 内原子更新，杜绝不一致）----
  const insert = (ch: string) =>
    setEdit(({ text, cursor }) => ({
      text: text.slice(0, cursor) + ch + text.slice(cursor),
      cursor: cursor + ch.length,
    }));
  const backspace = () =>
    setEdit(({ text, cursor }) =>
      cursor <= 0
        ? { text, cursor }
        : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 },
    );
  const deleteForward = () =>
    setEdit(({ text, cursor }) =>
      cursor >= text.length
        ? { text, cursor }
        : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor },
    );

  useInput((input, key) => {
    if (pickerVisible) {
      // picker 活跃：↑↓ 导航、Enter（含 Shift/Ctrl——picker 单行语义，换行无意义）执行、Esc 关闭。
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
        setEdit({ text: '', cursor: 0 });
        return;
      }
      if (key.escape) {
        setPickerDismissed(true);
        return;
      }
    } else {
      // 非 picker：Esc 双击清空 + 历史导航（门控）+ 换行/提交 + 光标移动。
      if (key.escape) {
        const now = Date.now();
        if (now - lastEscRef.current < DOUBLE_ESC_MS) {
          setEdit({ text: '', cursor: 0 });
          dispatch({ type: 'reset' });
        }
        lastEscRef.current = now;
        return;
      }
      // 上下键门控（详设 §3.6）：cursor 在首/末行才翻历史，否则跨行移动光标。
      if (key.upArrow) {
        if (isOnFirstLine(edit.text, edit.cursor)) {
          dispatch({ type: 'setDraft', draft: edit });
          dispatch({ type: 'up' });
        } else {
          setEdit(({ text, cursor }) => ({ text, cursor: moveUp(text, cursor) }));
        }
        return;
      }
      if (key.downArrow) {
        if (isOnLastLine(edit.text, edit.cursor)) {
          dispatch({ type: 'down' });
        } else {
          setEdit(({ text, cursor }) => ({ text, cursor: moveDown(text, cursor) }));
        }
        return;
      }
      if (key.return) {
        // 换行键（详设 §3.3）：Shift / Ctrl → 插 \n；行尾 \ + 裸 Enter → 续行；否则提交。
        // Ctrl+Enter（Kitty 路径）：支持 Kitty 的终端发 \x1b[13;5u → {return, ctrl:true}
        if (key.shift || key.ctrl) {
          insert('\n');
          return;
        }
        if (edit.cursor > 0 && edit.text[edit.cursor - 1] === '\\') {
          // 续行：删 \ 插 \n，cursor 不变（长度相抵，落在新行首）。
          setEdit(({ text, cursor }) => ({
            text: text.slice(0, cursor - 1) + '\n' + text.slice(cursor),
            cursor,
          }));
          return;
        }
        const trimmed = edit.text.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        dispatch({ type: 'push', text: trimmed });
        setEdit({ text: '', cursor: 0 });
        return;
      }
      if (key.leftArrow) {
        setEdit(({ text, cursor }) => ({ text, cursor: Math.max(0, cursor - 1) }));
        return;
      }
      if (key.rightArrow) {
        setEdit(({ text, cursor }) => ({ text, cursor: Math.min(text.length, cursor + 1) }));
        return;
      }
      if (key.home) {
        setEdit(({ text, cursor }) => ({ text, cursor: lineStart(text, cursor) }));
        return;
      }
      if (key.end) {
        setEdit(({ text, cursor }) => ({ text, cursor: lineEnd(text, cursor) }));
        return;
      }
    }

    // 共用：backspace（跨行合并）/ delete / 字符插入（picker 与非 picker 都编辑；编辑即复位 picker）。
    // Ctrl+Enter（非 Kitty 路径）：终端发 \n(LF)，ink 解析为 {name:'enter'}（非 return，无 ctrl 标记）。
    // 在此拦住 \n → 插换行（全平台通用，不依赖终端协议）。仅拦单字符 \n：粘贴多行文本时 input
    // 长度 >1 不进此分支，按原逻辑被 \x20 门控过滤（粘贴兜底不受影响）。
    if (input === '\n') {
      insert('\n');
      setPickerDismissed(false);
      return;
    }
    if (key.backspace) {
      backspace();
      setPickerDismissed(false);
      return;
    }
    if (key.delete) {
      deleteForward();
      setPickerDismissed(false);
      return;
    }
    if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 0x20) {
      insert(input);
      setPickerDismissed(false);
    }
  });

  // 历史浏览时显示历史项（cursor 定末尾，只读），否则当前草稿。
  const browsing = hist.index !== -1;
  const displayed = browsing ? hist.items[hist.index] ?? '' : edit.text;
  const cursor = browsing ? displayed.length : edit.cursor;

  // 多行渲染：按 \n 拆行 + cursor 反白格 + maxHeight 窗口滚动。
  const lines = displayed.split('\n');
  let curRow = 0;
  let curCol = 0;
  for (let i = 0; i < cursor && i < displayed.length; i++) {
    if (displayed[i] === '\n') {
      curRow++;
      curCol = 0;
    } else {
      curCol++;
    }
  }
  const startRow =
    lines.length <= INPUT_MAX_HEIGHT
      ? 0
      : Math.min(Math.max(0, curRow - INPUT_MAX_HEIGHT + 1), lines.length - INPUT_MAX_HEIGHT);
  const visibleLines = lines.slice(startRow, startRow + INPUT_MAX_HEIGHT);

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
      {visibleLines.map((line, idx) => {
        const realRow = startRow + idx;
        const isCursorRow = realRow === curRow;
        const promptPrefix = realRow === 0 ? `${SYMBOLS.user} ` : '  ';
        if (isCursorRow) {
          const before = line.slice(0, curCol);
          const atEnd = curCol >= line.length;
          const cursorChar = atEnd ? ' ' : line[curCol];
          const after = atEnd ? '' : line.slice(curCol + 1);
          return (
            <Box key={realRow}>
              <Text color={T.user}>{promptPrefix}</Text>
              <Text>{before}</Text>
              <Text backgroundColor={T.muted} color={T.inverseText}>
                {cursorChar}
              </Text>
              {after.length > 0 ? <Text>{after}</Text> : null}
            </Box>
          );
        }
        return (
          <Box key={realRow}>
            <Text color={T.user}>{promptPrefix}</Text>
            {line.length === 0 ? <Text> </Text> : <Text>{line}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
