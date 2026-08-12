/**
 * 调试脚本：绕过 SDK，直接 fetch 看 Astron/Anthropic 端点返回的 SSE 原始帧。
 *
 * 用途：
 *   - 确认 message_start / content_block_start / message_delta 等事件是接口真实返回的
 *   - 看 usage（token 计数）在每个帧里的真实值（如 message_start 给 0、message_delta 给真值）
 *
 * 跑法：
 *   npx tsx scripts/raw-sse.ts
 *   （需先在 .env 配好 ECODE_BASE_URL / ANTHROPIC_API_KEY / ECODE_MODEL）
 *
 * 想换提问/工具：改下面的 messages 和 tools。不回显 key / 完整域名。
 */
import 'dotenv/config'

const baseURL = process.env.ECODE_BASE_URL
const apiKey = process.env.ANTHROPIC_API_KEY
const model = process.env.ECODE_MODEL ?? 'glm-5.2'

if (!baseURL || !apiKey || apiKey.includes('your-key')) {
  console.error('✗ .env 未配置有效的 ECODE_BASE_URL / ANTHROPIC_API_KEY')
  console.error('  复制 .env.example 为 .env，填入 Astron 端点地址和 API Key')
  process.exit(1)
}

// endpoint：baseURL 可能含或不含 /v1，两种都兜住
const base = baseURL.replace(/\/+$/, '')
const endpoint = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages'

console.log(`# 直接 fetch（不经 @anthropic-ai/sdk），看服务器 SSE 原始返回`)
console.log(`# model=${model}  路径=...${endpoint.slice(-18)}（域名/key 已脱敏）\n`)

const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model,
    max_tokens: 256,
    stream: true,
    system: '你是助手，用中文。',
    messages: [{ role: 'user', content: '先用一句话答应我，然后调用 read_file 读 package.json。' }],
    tools: [
      {
        name: 'read_file',
        description: '读取文件内容',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
  }),
})

if (!res.ok) {
  console.error(`✗ HTTP ${res.status} ${res.statusText}`)
  console.error(await res.text())
  process.exit(1)
}

console.log(`HTTP ${res.status}  content-type=${res.headers.get('content-type')}\n`)

let buf = ''
let frameNo = 0
const decoder = new TextDecoder()
for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
  buf += decoder.decode(chunk, { stream: true })
  let idx: number
  // SSE 帧以空行(\n\n)分隔
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    if (frame.trim()) {
      frameNo++
      console.log(`── SSE 帧[${frameNo}] ──`)
      console.log(frame)
      console.log('')
    }
  }
}
// 收尾
buf += decoder.decode()
if (buf.trim()) {
  frameNo++
  console.log(`── SSE 帧[${frameNo}]（尾）──`)
  console.log(buf)
}

console.log(`\n# 共 ${frameNo} 个原始 SSE 帧 —— 每一帧都是服务器真实推过来的文本`)
