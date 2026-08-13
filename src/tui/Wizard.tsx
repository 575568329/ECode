import { useState, useEffect } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { Select, type SelectItem } from './Select.js'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { theme } from './theme.js'
import type { WizardValues } from '../services/config.js'
import type { ThinkingLevel } from '../providers/interface.js'

/**
 * 配置向导（/setup 触发，方案 §10.1）：5 步表单。
 *   type(Select) → baseURL(TextInput) → apiKey(TextInput) → model(TextInput 逗号分隔) → thinking(Select)
 *
 * 复用 Select + TextInput（零新组件）；provider name 固定 'default'（不问 name）。
 * 不校验输入（写 config 后 loadConfig 兜底，无效再 banner，用户重跑 /setup）。
 * 思考强度默认 medium（active 定位）。
 */

type Step = 'type' | 'baseURL' | 'apiKey' | 'model' | 'thinking'
const STEPS: { key: Step; label: string; hint?: string }[] = [
  { key: 'type', label: '选择协议类型' },
  { key: 'baseURL', label: '端点 baseURL', hint: '如 https://api.example.com' },
  { key: 'apiKey', label: 'API Key' },
  { key: 'model', label: '模型（逗号分隔多个）', hint: '如 glm-5.2, glm-4-flash' },
  { key: 'thinking', label: '思考强度' },
]

interface WizardProps {
  onComplete: (values: WizardValues) => void
  onCancel: () => void
}

function isTextStep(step: Step): boolean {
  return step === 'baseURL' || step === 'apiKey' || step === 'model'
}

export function Wizard({ onComplete, onCancel }: WizardProps): ReactElement {
  const [stepIdx, setStepIdx] = useState(0)
  const [type, setType] = useState<'anthropic' | 'openai'>('anthropic')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('')
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))

  const meta = STEPS[stepIdx]
  const step = meta.key
  const progress = `${stepIdx + 1}/${STEPS.length}`

  // 切到 TextInput 步时重置 cursor（带入已填值；当前无回退故恒为空，保留读 existing 便于未来加回退）
  useEffect(() => {
    if (isTextStep(step)) {
      const existing = step === 'baseURL' ? baseURL : step === 'apiKey' ? apiKey : models
      setCur(createCursor(existing))
    }
    // 依赖 stepIdx：仅在步进时重置（不随 baseURL/apiKey/models 变化重跑）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx])

  // TextInput 步拦 Esc 取消（Select 步由 Select 自身 onCancel 处理，避免双重）
  useInput((_input, key) => {
    if (isTextStep(step) && key.escape) onCancel()
  })

  // TextInput 回车：记值 + 进下一步
  const commitText = () => {
    const text = cur.text.trim()
    if (step === 'baseURL') setBaseURL(text)
    else if (step === 'apiKey') setApiKey(text)
    else if (step === 'model') setModels(text)
    setStepIdx((i) => i + 1)
  }

  if (step === 'type') {
    const items: SelectItem<'anthropic' | 'openai'>[] = [
      { label: 'anthropic（Anthropic 兼容：智谱/Claude 等）', value: 'anthropic', active: type === 'anthropic' },
      { label: 'openai（OpenAI 兼容：DeepSeek/OpenAI 等）', value: 'openai', active: type === 'openai' },
    ]
    return (
      <Select
        title={`${meta.label}（${progress}）`}
        items={items}
        onSelect={(v) => {
          setType(v)
          setStepIdx((i) => i + 1)
        }}
        onCancel={onCancel}
      />
    )
  }

  if (step === 'thinking') {
    const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high']
    const items: SelectItem<ThinkingLevel>[] = levels.map((lv) => ({
      label: lv,
      value: lv,
      active: lv === 'medium',
    }))
    return (
      <Select
        title={`${meta.label}（${progress}）`}
        items={items}
        // 最后一步：用回调值 thinking + 前 4 步已稳定的 state 组装 WizardValues
        onSelect={(v) => onComplete({ type, baseURL, apiKey, models, thinking: v })}
        onCancel={onCancel}
      />
    )
  }

  // TextInput 步（baseURL / apiKey / model）
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {meta.label}（{progress}）
      </Text>
      {meta.hint && <Text dimColor>{meta.hint}</Text>}
      <Box marginTop={1}>
        <TextInput value={cur.text} caret={cur.caret} onInput={setCur} onSubmit={commitText} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>回车下一步 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
