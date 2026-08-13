import { useState, useEffect } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { Select, type SelectItem } from './Select.js'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { theme } from './theme.js'
import type { WizardValues } from '../services/config.js'
import type { ProviderCfg } from '../services/config.js'
import type { ThinkingLevel } from '../providers/interface.js'

/**
 * 配置向导（/setup 触发，方案 §10.1）：增量改 provider（新增/编辑），保留其他 + 注释。
 *
 * 流程自适应：
 *   - 无现有 provider（首次/损坏）→ 直接新增（5 步，name 固定 'default'）
 *   - 有现有 provider → 第 0 步选「新增」或「编辑 astron/deepseek/...」
 *     · 新增：问 name → type → baseURL → apiKey → model → thinking（6 步）
 *     · 编辑：跳过 name（用现有）+ 后续步骤预填当前值（不改回车跳过）
 *
 * 复用 Select + TextInput；写 config 后 loadConfig 兜底校验（无效再 banner，用户重跑 /setup）。
 */

type Step = 'mode' | 'name' | 'type' | 'baseURL' | 'apiKey' | 'model' | 'thinking'

interface ExistingProvider {
  name: string
  cfg: ProviderCfg
}

interface WizardProps {
  onComplete: (values: WizardValues) => void
  onCancel: () => void
  /** 现有 provider 列表（空 = 首次，跳过 mode 步直接新增 name='default'） */
  existingProviders?: ExistingProvider[]
}

/** 是否 TextInput 步（回车提交 + 预填）；Select 步（mode/type/thinking）自管 */
function isTextStep(step: Step): boolean {
  return step === 'name' || step === 'baseURL' || step === 'apiKey' || step === 'model'
}

export function Wizard({ onComplete, onCancel, existingProviders = [] }: WizardProps): ReactElement {
  const hasProviders = existingProviders.length > 0
  // mode 初始：无现有 provider 强制 add（跳过 mode 步）；否则 'add' 待 mode 步选
  const [mode, setMode] = useState<'add' | 'edit'>(hasProviders ? 'add' : 'add')
  const [providerName, setProviderName] = useState('') // 新增时填；编辑时由 mode 选择设入
  const [stepIdx, setStepIdx] = useState(0)
  const [type, setType] = useState<'anthropic' | 'openai'>('anthropic')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('')
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))

  // 步序列：动态按 hasProviders + mode 构造（mode 步仅 hasProviders 时有；name 步仅 add 时有）
  const steps: Step[] = (() => {
    const s: Step[] = []
    if (hasProviders) s.push('mode')
    if (mode === 'add' && hasProviders) s.push('name') // 首次（无 hasProviders）name 固定 default，不问
    s.push('type', 'baseURL', 'apiKey', 'model', 'thinking')
    return s
  })()
  const step = steps[stepIdx]
  const progress = `${stepIdx + 1}/${steps.length}`

  // 编辑模式：从 existingProviders 取当前 provider 的预填值
  const editing = mode === 'edit' ? existingProviders.find((p) => p.name === providerName)?.cfg : undefined

  // 切到文本步时带入预填值（编辑模式=当前值；新增/首次=空）
  useEffect(() => {
    if (!isTextStep(step)) return
    let existing = ''
    if (mode === 'edit' && editing) {
      if (step === 'baseURL') existing = editing.baseURL
      else if (step === 'apiKey') existing = editing.apiKey
      else if (step === 'model') existing = editing.models.join(', ')
    }
    setCur(createCursor(existing))
    // 依赖 stepIdx：仅在步进时重置 cursor（不随编辑 state 变化重跑）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx])

  // 文本步拦 Esc（Select 步由 Select 自身 onCancel 处理）
  useInput((_input, key) => {
    if (isTextStep(step) && key.escape) onCancel()
  })

  const commitText = () => {
    const text = cur.text.trim()
    if (step === 'name') setProviderName(text)
    else if (step === 'baseURL') setBaseURL(text)
    else if (step === 'apiKey') setApiKey(text)
    else if (step === 'model') setModels(text)
    setStepIdx((i) => i + 1)
  }

  // 最终组装（thinking 步 onSelect 触发；此时前序 state 已稳定）
  const finish = (thinking: ThinkingLevel) => {
    const name = !hasProviders ? 'default' : mode === 'add' ? providerName : providerName
    onComplete({ mode: hasProviders ? mode : 'add', providerName: name, type, baseURL, apiKey, models, thinking })
  }

  // ---- 各步渲染 ----
  if (step === 'mode') {
    const items: SelectItem<string>[] = [
      { label: '新增供应商', value: 'add' },
      ...existingProviders.map((p) => ({ label: `编辑：${p.name}`, value: `edit:${p.name}` })),
    ]
    return (
      <Select
        key="mode"
        title={`配置向导（${progress}）`}
        items={items}
        onSelect={(v) => {
          if (v === 'add') setMode('add')
          else {
            const name = v.split(':')[1]
            setMode('edit')
            setProviderName(name)
            // 预填编辑 provider 的现有值（避免后续步空，用户全回车=保留原值）
            const p = existingProviders.find((x) => x.name === name)
            if (p) {
              setType(p.cfg.type)
              setBaseURL(p.cfg.baseURL)
              setApiKey(p.cfg.apiKey)
              setModels(p.cfg.models.join(', '))
            }
          }
          setStepIdx((i) => i + 1)
        }}
        onCancel={onCancel}
      />
    )
  }

  if (step === 'type') {
    const items: SelectItem<'anthropic' | 'openai'>[] = [
      { label: 'anthropic（Anthropic 兼容：智谱/Claude 等）', value: 'anthropic', active: type === 'anthropic' },
      { label: 'openai（OpenAI 兼容：DeepSeek/OpenAI 等）', value: 'openai', active: type === 'openai' },
    ]
    return (
      <Select
        key="type"
        title={`协议类型（${progress}）`}
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
    const current = mode === 'edit' && editing?.thinking ? editing.thinking : 'medium'
    const items: SelectItem<ThinkingLevel>[] = levels.map((lv) => ({
      label: lv,
      value: lv,
      active: lv === current,
    }))
    return (
      <Select key="thinking" title={`思考强度（${progress}）`} items={items} onSelect={(v) => finish(v)} onCancel={onCancel} />
    )
  }

  // TextInput 步（name / baseURL / apiKey / model）
  const hints: Partial<Record<Step, string>> = {
    name: '如 astron / deepseek（自定义标识）',
    baseURL: '如 https://api.example.com',
    model: '如 glm-5.2, glm-4-flash（逗号分隔多个）',
  }
  const labels: Record<Step, string> = {
    mode: '',
    name: '供应商名称',
    type: '',
    baseURL: '端点 baseURL',
    apiKey: 'API Key',
    model: '模型',
    thinking: '',
  }
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {labels[step]}（{progress}）
      </Text>
      {hints[step] && <Text dimColor>{hints[step]}</Text>}
      <Box marginTop={1}>
        <TextInput value={cur.text} caret={cur.caret} onInput={setCur} onSubmit={commitText} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>回车下一步 · Esc 取消{mode === 'edit' ? '（空=保留原值）' : ''}</Text>
      </Box>
    </Box>
  )
}
