/**
 * M13-B0 探针：cache_control 打标/不打标各 3 轮同 prompt 会话对比（方案 §4.1 验证/B5 放行前提）。
 * 读真实 ~/.ecode/config.json（loadConfig JSONC 兼容）；只发请求读 usage，不写任何文件。
 * 结论回写：docs/详设/2026-08-24_后续-M13-实施方案_待审核.md §10 B0 回写位。
 */
import { loadConfig } from '../src/services/config.js'

const c = loadConfig()
const cur = c.providers[c.current.name]
if (cur.type !== 'anthropic' || cur.apiKey === undefined) throw new Error('需要 anthropic 型 provider + apiKey')
const url = `${cur.baseURL.replace(/\/$/, '')}/v1/messages`

/** ≈2500 token 的稳定前缀（超出 Anthropic 1024 token 缓存下限，留足余量） */
const filler = Array.from({ length: 40 }, (_, i) => `规则 ${i + 1}：ECode 是终端 Agent CLI，本段为缓存探针的固定前缀填充，逐条编号以确保字节级稳定。`).join('\n')
const system = `你是 ECode 缓存探针。${filler}`

interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

async function call(body: Record<string, unknown>): Promise<Usage> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cur.apiKey as string, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  const j = (await r.json()) as { usage?: Usage; error?: { message?: string } }
  if (!r.ok || j.usage === undefined) throw new Error(`HTTP ${r.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`)
  return j.usage
}

/** 三轮会话（同前缀逐轮增长）；mark=true 时在最后一条 user 文本块打 ephemeral 尾断点（B5 规则） */
async function session(mark: boolean, label: string): Promise<void> {
  const history: Array<{ role: string; content: Array<Record<string, unknown>> }> = []
  for (let turn = 1; turn <= 3; turn++) {
    history.push({ role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮：请只回复 ok` }] })
    const msgs = history.map((m, i) => {
      const isLastUser = i === history.length - 1
      if (mark && isLastUser) {
        return { role: m.role, content: [{ ...m.content[0], cache_control: { type: 'ephemeral' } }] }
      }
      return m
    })
    const u = await call({ model: c.current.model, max_tokens: 16, system, messages: msgs })
    console.log(`[${label}] 轮${turn}: in=${u.input_tokens} cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`)
    history.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
  }
}

async function main(): Promise<void> {
  await session(false, '不打标')
  await session(true, '打标  ')
}
void main()
