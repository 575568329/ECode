/**
 * ask_user 选项面板（M8 §2）：↑↓ 选择 + 回车确定（PanelShell 基线，M6 T4 裁决不回退）。
 *
 * 交互：每题一屏（多问时 header chips 显进度，←→ 切题）；单选回车即答；多选 space
 * toggle + 回车进下一题；Other 恒居末位（回车展开内联 TextInput）；末尾 Review 页
 * 列 问题→答案，回车提交全部；Esc 任意页取消整体提问。
 * 样式借 PanelShell 的框/高亮惯例（列表 ≤5 项无滚动/搜索需求，独立 useInput 更直接）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { theme } from './theme.js'
import type { AskUserQuestion, AskUserResult } from '../tools/builtin/ask_user.js'

const OTHER = '__other__'

interface QuestionPanelProps {
  questions: AskUserQuestion[]
  resolve: (result: AskUserResult) => void
  onCancel: () => void
}

export function QuestionPanel({ questions, resolve, onCancel }: QuestionPanelProps): ReactElement {
  const [qIdx, setQIdx] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set()) // 多选已 toggle 的选项下标
  // answers[i]：单选 = label；多选 = label 数组；undefined = 未答。Other 输入存下标 OTHER+i + 文本
  const [answers, setAnswers] = useState<Array<string | string[] | undefined>>(questions.map(() => undefined))
  const [otherText, setOtherText] = useState<CursorState | null>(null) // 非 null = Other 输入态
  const [review, setReview] = useState(false)

  const q = questions[qIdx]
  if (q === undefined) return <Text>（无问题）</Text>
  const options = [...q.options.map((o) => o.label), OTHER]
  const multi = q.multiSelect === true
  const isLast = qIdx === questions.length - 1

  const finish = (final: Array<string | string[]>): void => resolve({ kind: 'answers', answers: final })

  /** 提交当前题答案 → 单问单选直接 resolve（无确认页）；否则下一题 / Review */
  const advance = (answer: string | string[]): void => {
    const next = answers.map((a, i) => (i === qIdx ? answer : a))
    setAnswers(next)
    setSelected(new Set())
    setCursor(0)
    if (isLast) {
      // 方案 §2：单问题单选回车即提交（无 Review）；多问题或多选走 Review 确认
      if (questions.length === 1 && !multi) finish([answer] as Array<string | string[]>)
      else setReview(true)
    } else setQIdx(qIdx + 1)
  }

  useInput((input, key) => {
    // Other 输入态：独占（回车提交、Esc 退回选择；不再处理面板键位）
    if (otherText !== null) {
      if (key.return) {
        const text = otherText.text.trim()
        if (text === '') {
          setOtherText(null)
          return
        }
        const a = answers[qIdx]
        if (multi) {
          const list = Array.isArray(a) ? [...a] : []
          advance([...list, text])
        } else advance(text)
        setOtherText(null)
      } else if (key.escape) {
        setOtherText(null)
      }
      return
    }

    if (review) {
      if (key.return) {
        // 未答的题以「（未作答）」占位——提交不挂死
        finish(answers.map((a) => a ?? '（未作答）'))
      } else if (key.leftArrow || key.backspace) {
        setReview(false)
        setQIdx(questions.length - 1)
      } else if (key.escape) onCancel()
      return
    }

    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel() // Esc/Ctrl+C 取消提问（与 ConfirmPrompt 心智一致）
      return
    }
    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? options.length - 1 : c - 1))
      return
    }
    if (key.downArrow) {
      setCursor((c) => (c >= options.length - 1 ? 0 : c + 1))
      return
    }
    if (key.leftArrow) {
      if (qIdx > 0) {
        setQIdx(qIdx - 1)
        setCursor(0)
        setSelected(new Set())
      }
      return
    }
    if (key.rightArrow) {
      // 未答也允许跳过（Review 会以「（未作答）」占位）——向前导航不设卡
      if (isLast) setReview(true)
      else {
        setQIdx(qIdx + 1)
        setCursor(0)
        setSelected(new Set())
      }
      return
    }
    if (input === ' ' && multi) { // 空格 toggle（Ink Key 无 space 标志，input 判）
      if (cursor < options.length - 1) {
        setSelected((s) => {
          const n = new Set(s)
          if (n.has(cursor)) n.delete(cursor)
          else n.add(cursor)
          return n
        })
      }
      return
    }
    if (key.return) {
      if (cursor === options.length - 1) {
        // Other
        setOtherText(createCursor(''))
        return
      }
      if (multi) {
        // 多选回车 = 确认本题：答案取本次 toggle 的 selected（Other 输入在 Other 分支追加）
        const picked = [...selected].sort((a, b) => a - b).map((i) => options[i] as string)
        advance(picked)
      } else advance(options[cursor] as string)
    }
  })

  // —— 渲染 ——
  const renderOption = (label: string, i: number): ReactElement => {
    const isCursor = i === cursor
    const checked = multi && selected.has(i)
    const desc = i < q.options.length ? q.options[i]?.description : '自由输入你的答案'
    const mark = multi ? (checked ? '[✓] ' : '[ ] ') : ''
    const display = label === OTHER ? 'Other' : label
    return (
      <Text key={label + i} inverse={isCursor} bold={isCursor} color={isCursor ? undefined : theme.assistant}>
        {` ${mark}${i < q.options.length ? `${i + 1}. ` : ''}${display}`}
        {desc !== undefined && !isCursor ? <Text dimColor> — {desc}</Text> : null}
      </Text>
    )
  }

  if (review) {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text color={theme.info} bold> 确认答案</Text>
        <Box flexDirection="column" marginTop={1}>
          {questions.map((qq, i) => (
            <Text key={`rv${i}`}>
              {' '}
              {qq.header}：{Array.isArray(answers[i]) ? (answers[i] as string[]).join('、') : (answers[i] as string) ?? '（未作答）'}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor> 回车 提交 · ← 返回修改 · Esc 取消提问</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      {questions.length > 1 && (
        <Box>
          {questions.map((qq, i) => (
            <Text
              key={`chip${i}`}
              inverse={i === qIdx}
              bold={i === qIdx}
              color={i === qIdx ? undefined : answers[i] !== undefined ? theme.assistant : theme.border}
            >
              {i === 0 ? ' ' : '  '}
              {answers[i] !== undefined ? '●' : '○'}
              {qq.header}
            </Text>
          ))}
          <Text dimColor> （{qIdx + 1}/{questions.length}）</Text>
        </Box>
      )}
      <Box marginTop={questions.length > 1 ? 1 : 0}>
        <Text color={theme.info} bold> {q.question}{multi ? '（可多选）' : ''}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map(renderOption)}
      </Box>
      {otherText !== null && (
        <Box marginTop={1}>
          <Text dimColor> Other：</Text>
          <TextInput value={otherText.text} caret={otherText.caret} onInput={setOtherText} />
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {` ${multi ? 'space 勾选 · 回车 确定本题' : '回车 确定'} · ${questions.length > 1 ? '←→ 切题 · ' : ''}→ 跳过 · Esc 取消提问`}
        </Text>
      </Box>
    </Box>
  )
}
